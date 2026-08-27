export const ACTIVE_SYNC_INTERVAL_MS = 120_000
export const ACTIVE_SYNC_JITTER_FRACTION = 0.2
export const IDLE_SYNC_MIN_MS = 300_000
export const IDLE_SYNC_MAX_MS = 600_000
export const IDLE_AFTER_EMPTY_RUNS = 3
export const SUSPEND_HEARTBEAT_MS = 30_000
export const SUSPEND_LATE_AFTER_MS = 60_000
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SyncRunResult { changed: boolean }

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

interface ArmedTimer {
  handle: unknown
  hasHandle: boolean
  active: boolean
  arming: boolean
  firedSynchronously: boolean
}

interface AccountState {
  account: string
  timer: ArmedTimer | null
  nextRunAt: number | null
  inFlight: Promise<void> | null
  followUp: boolean
  consecutiveEmpty: number
  lastSuccessAt: number | null
  lastError: string | null
  removed: boolean
  scheduleFailed: boolean
}

type MaintenanceMode = 'none' | 'additions' | 'all'

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

/** One process-local scheduler with one serialized account-maintenance engine. */
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
  #maintenancePromise: Promise<void> | null = null
  #maintenancePending: MaintenanceMode = 'none'
  #heartbeat: ArmedTimer | null = null
  #heartbeatDueAt: number | null = null
  #heartbeatRetryQueued = false

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
    await this.#requestMaintenance('all')
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopping = true
    this.#stopPromise = (async () => {
      this.#clearTimers()
      await this.#startPromise?.catch(() => undefined)
      this.#clearTimers()
      await this.#refreshPromise?.catch(() => undefined)
      this.#maintenancePending = 'none'
      await this.#maintenancePromise?.catch(() => undefined)
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

  #armTimer(callback: () => void, delayMs: number): ArmedTimer {
    const timer: ArmedTimer = {
      handle: undefined,
      hasHandle: false,
      active: true,
      arming: true,
      firedSynchronously: false,
    }
    try {
      timer.handle = this.#deps.setTimeout(() => {
        if (!timer.active) return
        if (timer.arming) {
          timer.firedSynchronously = true
          return
        }
        callback()
      }, delayMs)
      timer.hasHandle = true
      timer.arming = false
      if (timer.firedSynchronously) {
        this.#cancelTimer(timer)
        throw new Error('setTimeout callbacks must run asynchronously')
      }
      return timer
    } catch (error) {
      timer.arming = false
      if (timer.active && timer.hasHandle) this.#clearExternalTimer(timer.handle)
      timer.active = false
      throw error
    }
  }

  #clearExternalTimer(handle: unknown, account = ''): void {
    try { this.#deps.clearTimeout(handle) }
    catch (error) { this.#reportError(sanitizedError(error, account)) }
  }

  #cancelTimer(timer: ArmedTimer, account = ''): void {
    if (!timer.active) return
    timer.active = false
    if (timer.hasHandle) this.#clearExternalTimer(timer.handle, account)
  }

  #clearTimers(): void {
    const heartbeat = this.#heartbeat
    this.#heartbeat = null
    this.#heartbeatDueAt = null
    if (heartbeat) this.#cancelTimer(heartbeat)
    for (const state of this.#accounts.values()) {
      const timer = state.timer
      state.timer = null
      state.nextRunAt = null
      state.followUp = false
      if (timer) this.#cancelTimer(timer, state.account)
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
    if (previous) this.#cancelTimer(previous, state.account)
    try {
      let timer!: ArmedTimer
      timer = this.#armTimer(() => {
        if (state.timer !== timer) return
        state.timer = null
        state.nextRunAt = null
        timer.active = false
        void this.#request(state)
      }, delayMs)
      state.timer = timer
      state.nextRunAt = this.#deps.now() + delayMs
      state.scheduleFailed = false
    } catch (error) {
      state.scheduleFailed = true
      throw error
    }
  }

  #request(state: AccountState): Promise<void> {
    if (this.#stopping || state.removed) return Promise.resolve()
    const timer = state.timer
    state.timer = null
    state.nextRunAt = null
    if (timer) this.#cancelTimer(timer, state.account)
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
        if (timer) this.#cancelTimer(timer, state.account)
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

  #mergeMaintenanceMode(mode: Exclude<MaintenanceMode, 'none'>): void {
    if (mode === 'all' || this.#maintenancePending === 'none') this.#maintenancePending = mode
  }

  #requestMaintenance(mode: Exclude<MaintenanceMode, 'none'>): Promise<void> {
    if (this.#stopping) return Promise.resolve()
    this.#mergeMaintenanceMode(mode)
    if (this.#maintenancePromise) return this.#maintenancePromise
    const wave = (async () => {
      try {
        while (this.#maintenancePending !== 'none' && !this.#stopping) {
          const current = this.#maintenancePending
          this.#maintenancePending = 'none'
          const added = await this.#refreshAccounts()
          if (this.#stopping) break
          const targets = current === 'all'
            ? [...this.#accounts.values()].filter((state) => !state.removed)
            : [...new Set([
                ...added,
                ...[...this.#accounts.values()].filter((state) => state.scheduleFailed && !state.removed),
              ])]
          await Promise.all(targets.map((state) => this.#request(state)))
        }
      } catch (error) {
        const message = sanitizedError(error, '')
        this.#reportError(message)
        for (const state of this.#accounts.values()) state.lastError = message
      }
    })()
    const tracked = wave.finally(() => {
      if (this.#maintenancePromise === tracked) this.#maintenancePromise = null
    })
    this.#maintenancePromise = tracked
    return tracked
  }

  #scheduleHeartbeat(): void {
    if (this.#stopping) return
    const dueAt = this.#deps.now() + this.#heartbeatMs
    let timer!: ArmedTimer
    timer = this.#armTimer(() => {
      if (this.#heartbeat !== timer) return
      this.#heartbeat = null
      timer.active = false
      const lateBy = this.#deps.now() - (this.#heartbeatDueAt ?? this.#deps.now())
      this.#heartbeatDueAt = null
      const maintenance = this.#requestMaintenance(lateBy >= this.#suspendLateAfterMs ? 'all' : 'additions')
      try { this.#scheduleHeartbeat() }
      catch (error) { this.#queueHeartbeatRetry(maintenance, error) }
    }, this.#heartbeatMs)
    this.#heartbeat = timer
    this.#heartbeatDueAt = dueAt
  }

  #queueHeartbeatRetry(maintenance: Promise<void>, error: unknown): void {
    const first = sanitizedError(error, '')
    this.#reportError(first)
    for (const state of this.#accounts.values()) state.lastError = first
    if (this.#heartbeatRetryQueued || this.#stopping) return
    this.#heartbeatRetryQueued = true
    queueMicrotask(() => {
      void (async () => {
        await maintenance.catch(() => undefined)
        this.#heartbeatRetryQueued = false
        if (this.#stopping || this.#heartbeat) return
        try { this.#scheduleHeartbeat() }
        catch (retryError) {
          const message = sanitizedError(
            new Error(`sync maintenance degraded: ${retryError instanceof Error ? retryError.message : 'heartbeat timer unavailable'}`),
            '',
          )
          this.#reportError(message)
          for (const state of this.#accounts.values()) state.lastError = message
        }
      })()
    })
  }

  #reportError(message: string): void {
    try { this.#deps.onError?.(message) }
    catch { /* diagnostics must never break scheduling */ }
  }
}
