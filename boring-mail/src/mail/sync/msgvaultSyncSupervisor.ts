export const ACTIVE_SYNC_INTERVAL_MS = 120_000
export const ACTIVE_SYNC_JITTER_FRACTION = 0.2
export const IDLE_SYNC_MIN_MS = 300_000
export const IDLE_SYNC_MAX_MS = 600_000
export const IDLE_AFTER_EMPTY_RUNS = 3
export const SUSPEND_HEARTBEAT_MS = 30_000
export const SUSPEND_LATE_AFTER_MS = 60_000
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SyncRunResult {
  changed: boolean
}

export interface MsgvaultSyncSupervisorDependencies {
  discoverAccounts(): Promise<string[]>
  syncAccount(account: string): Promise<SyncRunResult>
  now(): number
  random(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
  onError?(message: string): void
}

export interface MsgvaultSyncSupervisorOptions {
  activeIntervalMs?: number
  activeJitterFraction?: number
  idleMinMs?: number
  idleMaxMs?: number
  idleAfterEmptyRuns?: number
  heartbeatMs?: number
  suspendLateAfterMs?: number
}

export interface AccountSyncHealth {
  readonly account: string
  readonly lastSuccessAt: number | null
  readonly lastSuccessAgeMs: number | null
  readonly inFlight: boolean
  readonly consecutiveEmpty: number
  readonly nextRunAt: number | null
  readonly lastError: string | null
}

interface AccountState {
  account: string
  timer: unknown | null
  nextRunAt: number | null
  inFlight: Promise<void> | null
  followUp: boolean
  consecutiveEmpty: number
  lastSuccessAt: number | null
  lastError: string | null
  removed: boolean
  scheduleFailed: boolean
}

function finitePositiveTimer(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function boundedRandom(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('random() must return [0,1)')
  return value
}

function sanitizedError(error: unknown, account: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? 'sync failed'
  const redacted = (account ? firstLine.replaceAll(account, '[account]') : firstLine)
    .replace(/(?:oauth|access|refresh|client)[_-]?(?:token|secret)\s*[:=]\s*\S+/gi, '[credential redacted]')
    .replace(/(?:[A-Za-z]:\\|\/)\S+/g, '[path]')
  return redacted.slice(0, 240) || 'sync failed'
}

/** One process-local scheduler with serialized discovery and lifecycle. */
export class MsgvaultSyncSupervisor {
  readonly #deps: MsgvaultSyncSupervisorDependencies
  readonly #activeIntervalMs: number
  readonly #activeJitterFraction: number
  readonly #idleMinMs: number
  readonly #idleMaxMs: number
  readonly #idleAfterEmptyRuns: number
  readonly #heartbeatMs: number
  readonly #suspendLateAfterMs: number
  readonly #accounts = new Map<string, AccountState>()
  #started = false
  #stopping = false
  #startPromise: Promise<void> | null = null
  #stopPromise: Promise<void> | null = null
  #refreshPromise: Promise<AccountState[]> | null = null
  #reconcileWave: Promise<void> | null = null
  #heartbeat: unknown | null = null
  #heartbeatDueAt: number | null = null
  #resumeWave: Promise<void> | null = null
  #resumePending = false

  constructor(deps: MsgvaultSyncSupervisorDependencies, options: MsgvaultSyncSupervisorOptions = {}) {
    this.#deps = deps
    this.#activeIntervalMs = finitePositiveTimer(options.activeIntervalMs ?? ACTIVE_SYNC_INTERVAL_MS, 'activeIntervalMs')
    this.#activeJitterFraction = options.activeJitterFraction ?? ACTIVE_SYNC_JITTER_FRACTION
    if (!Number.isFinite(this.#activeJitterFraction) || this.#activeJitterFraction < 0 || this.#activeJitterFraction >= 1) {
      throw new Error('activeJitterFraction must be at least zero and less than one')
    }
    if (this.#activeIntervalMs * (1 + this.#activeJitterFraction) > MAX_TIMER_DELAY_MS) {
      throw new Error(`active jitter upper bound must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    this.#idleMinMs = finitePositiveTimer(options.idleMinMs ?? IDLE_SYNC_MIN_MS, 'idleMinMs')
    this.#idleMaxMs = finitePositiveTimer(options.idleMaxMs ?? IDLE_SYNC_MAX_MS, 'idleMaxMs')
    if (this.#idleMaxMs < this.#idleMinMs) throw new Error('idleMaxMs must be >= idleMinMs')
    this.#idleAfterEmptyRuns = positiveSafeInteger(options.idleAfterEmptyRuns ?? IDLE_AFTER_EMPTY_RUNS, 'idleAfterEmptyRuns')
    this.#heartbeatMs = finitePositiveTimer(options.heartbeatMs ?? SUSPEND_HEARTBEAT_MS, 'heartbeatMs')
    this.#suspendLateAfterMs = finitePositiveTimer(options.suspendLateAfterMs ?? SUSPEND_LATE_AFTER_MS, 'suspendLateAfterMs')
  }

  start(): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error('sync supervisor is stopping'))
    if (this.#startPromise) return this.#startPromise
    this.#started = true
    this.#startPromise = (async () => {
      try {
        await this.#refreshAccounts()
        if (this.#stopping) return
        for (const state of this.#accounts.values()) this.#schedule(state, 0)
        this.#scheduleHeartbeat()
      } catch (error) {
        this.#clearTimers()
        this.#started = false
        throw error
      }
    })()
    return this.#startPromise
  }

  health(): readonly AccountSyncHealth[] {
    const now = this.#deps.now()
    return Object.freeze([...this.#accounts.values()]
      .filter((state) => !state.removed)
      .sort((a, b) => a.account.localeCompare(b.account))
      .map((state) => Object.freeze({
        account: state.account,
        lastSuccessAt: state.lastSuccessAt,
        lastSuccessAgeMs: state.lastSuccessAt === null ? null : Math.max(0, now - state.lastSuccessAt),
        inFlight: state.inFlight !== null,
        consecutiveEmpty: state.consecutiveEmpty,
        nextRunAt: state.nextRunAt,
        lastError: state.lastError,
      })))
  }

  async syncNow(account?: string): Promise<void> {
    await this.#startPromise
    if (!this.#started || this.#stopping) return
    if (account !== undefined) {
      const state = this.#accounts.get(account)
      if (!state || state.removed) throw new Error('sync account is not active')
      await this.#request(state)
      return
    }
    await this.#refreshAccounts()
    await Promise.all([...this.#accounts.values()].filter((state) => !state.removed).map((state) => this.#request(state)))
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopping = true
    this.#stopPromise = (async () => {
      this.#clearTimers()
      await this.#startPromise?.catch(() => undefined)
      this.#clearTimers()
      await this.#refreshPromise?.catch(() => undefined)
      await this.#reconcileWave?.catch(() => undefined)
      this.#resumePending = false
      await this.#resumeWave?.catch(() => undefined)
      for (;;) {
        const active = [...this.#accounts.values()].map((state) => state.inFlight).filter(Boolean) as Promise<void>[]
        if (active.length === 0) break
        await Promise.all(active)
      }
      this.#clearTimers()
      this.#started = false
    })()
    return this.#stopPromise
  }

  #clearTimer(handle: unknown, account = ''): void {
    try { this.#deps.clearTimeout(handle) }
    catch (error) {
      const message = sanitizedError(error, account)
      this.#reportError(message)
    }
  }

  #clearTimers(): void {
    const heartbeat = this.#heartbeat
    this.#heartbeat = null
    this.#heartbeatDueAt = null
    if (heartbeat !== null) this.#clearTimer(heartbeat)
    for (const state of this.#accounts.values()) {
      const timer = state.timer
      state.timer = null
      state.nextRunAt = null
      state.followUp = false
      if (timer !== null) this.#clearTimer(timer, state.account)
    }
  }

  #activeDelay(): number {
    const random = boundedRandom(this.#deps.random())
    return Math.max(1, Math.round(this.#activeIntervalMs * (1 - this.#activeJitterFraction + 2 * this.#activeJitterFraction * random)))
  }

  #idleDelay(): number {
    return Math.max(1, Math.round(this.#idleMinMs + (this.#idleMaxMs - this.#idleMinMs) * boundedRandom(this.#deps.random())))
  }

  #nextDelay(state: AccountState): number {
    return state.consecutiveEmpty >= this.#idleAfterEmptyRuns ? this.#idleDelay() : this.#activeDelay()
  }

  #schedule(state: AccountState, delayMs: number): void {
    if (this.#stopping || state.removed) return
    const previous = state.timer
    state.timer = null
    state.nextRunAt = null
    if (previous !== null) this.#clearTimer(previous, state.account)
    let handle: unknown
    try {
      handle = this.#deps.setTimeout(() => {
        if (state.timer !== handle) return
        state.timer = null
        state.nextRunAt = null
        void this.#request(state)
      }, delayMs)
    } catch (error) {
      state.scheduleFailed = true
      throw error
    }
    state.timer = handle
    state.nextRunAt = this.#deps.now() + delayMs
    state.scheduleFailed = false
  }

  #request(state: AccountState): Promise<void> {
    if (this.#stopping || state.removed) return Promise.resolve()
    const timer = state.timer
    state.timer = null
    state.nextRunAt = null
    if (timer !== null) this.#clearTimer(timer, state.account)
    state.scheduleFailed = false
    if (state.inFlight) {
      state.followUp = true
      return state.inFlight
    }
    const work = (async () => {
      do {
        state.followUp = false
        try {
          const result = await this.#deps.syncAccount(state.account)
          state.lastSuccessAt = this.#deps.now()
          state.lastError = null
          state.consecutiveEmpty = result.changed ? 0 : state.consecutiveEmpty + 1
        } catch (error) {
          state.consecutiveEmpty = 0
          state.lastError = sanitizedError(error, state.account)
          this.#reportError(state.lastError)
        }
      } while (state.followUp && !this.#stopping && !state.removed)
    })()
    state.inFlight = work.finally(() => {
      state.inFlight = null
      if (!this.#stopping && !state.removed) {
        try { this.#schedule(state, this.#nextDelay(state)) }
        catch (error) {
          state.lastError = sanitizedError(error, state.account)
          this.#reportError(state.lastError)
        }
      } else if (state.removed) this.#accounts.delete(state.account)
    })
    return state.inFlight
  }

  #refreshAccounts(): Promise<AccountState[]> {
    if (this.#refreshPromise) return this.#refreshPromise
    const refresh = (async () => {
      const discovered = await this.#deps.discoverAccounts()
      if (this.#stopping) return []
      const active = new Set(discovered)
      const added: AccountState[] = []
      for (const account of discovered) {
        const existing = this.#accounts.get(account)
        if (existing) {
          if (existing.removed) added.push(existing)
          existing.removed = false
          continue
        }
        const state: AccountState = {
          account,
          timer: null,
          nextRunAt: null,
          inFlight: null,
          followUp: false,
          consecutiveEmpty: 0,
          lastSuccessAt: null,
          lastError: null,
          removed: false,
          scheduleFailed: false,
        }
        this.#accounts.set(account, state)
        added.push(state)
      }
      for (const state of this.#accounts.values()) {
        if (active.has(state.account)) continue
        state.removed = true
        const timer = state.timer
        state.timer = null
        state.nextRunAt = null
        if (timer !== null) this.#clearTimer(timer, state.account)
        state.followUp = false
        if (!state.inFlight) this.#accounts.delete(state.account)
      }
      return added
    })()
    const tracked = refresh.finally(() => {
      if (this.#refreshPromise === tracked) this.#refreshPromise = null
    })
    this.#refreshPromise = tracked
    return tracked
  }

  #scheduleHeartbeat(): void {
    if (this.#stopping) return
    let handle: unknown
    const dueAt = this.#deps.now() + this.#heartbeatMs
    handle = this.#deps.setTimeout(() => {
      if (this.#heartbeat !== handle) return
      this.#heartbeat = null
      const lateBy = this.#deps.now() - (this.#heartbeatDueAt ?? this.#deps.now())
      this.#heartbeatDueAt = null
      // Execute this tick's work even when a transient timer rearm fails.
      if (lateBy >= this.#suspendLateAfterMs) this.#requestResumeWave()
      else void this.#refreshAndRunAdditions()
      try { this.#scheduleHeartbeat() }
      catch (error) {
        const message = sanitizedError(error, '')
        this.#reportError(message)
        for (const state of this.#accounts.values()) state.lastError = message
      }
    }, this.#heartbeatMs)
    this.#heartbeat = handle
    this.#heartbeatDueAt = dueAt
  }

  #refreshAndRunAdditions(): Promise<void> {
    if (this.#reconcileWave) return this.#reconcileWave
    const wave = (async () => {
      try {
        const added = await this.#refreshAccounts()
        const recover = [...this.#accounts.values()].filter((state) => state.scheduleFailed && !state.removed)
        await Promise.all([...new Set([...added, ...recover])].map((state) => this.#request(state)))
      } catch (error) {
        const message = sanitizedError(error, '')
        this.#reportError(message)
        for (const state of this.#accounts.values()) state.lastError = message
      }
    })()
    const tracked = wave.finally(() => {
      if (this.#reconcileWave === tracked) this.#reconcileWave = null
    })
    this.#reconcileWave = tracked
    return tracked
  }

  #reportError(message: string): void {
    try { this.#deps.onError?.(message) }
    catch { /* diagnostics must never break scheduling */ }
  }

  #requestResumeWave(): void {
    if (this.#stopping) return
    if (this.#resumeWave) {
      this.#resumePending = true
      return
    }
    this.#resumeWave = (async () => {
      do {
        this.#resumePending = false
        await this.#refreshAccounts()
        await Promise.all([...this.#accounts.values()].filter((state) => !state.removed).map((state) => this.#request(state)))
      } while (this.#resumePending && !this.#stopping)
    })().catch((error) => {
      const message = sanitizedError(error, '')
      this.#reportError(message)
      for (const state of this.#accounts.values()) state.lastError = message
    }).finally(() => { this.#resumeWave = null })
  }
}
