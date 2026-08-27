export const ACTIVE_SYNC_INTERVAL_MS = 120_000
export const ACTIVE_SYNC_JITTER_FRACTION = 0.2
export const IDLE_SYNC_MIN_MS = 300_000
export const IDLE_SYNC_MAX_MS = 600_000
export const IDLE_AFTER_EMPTY_RUNS = 3
export const SUSPEND_HEARTBEAT_MS = 30_000
export const SUSPEND_LATE_AFTER_MS = 60_000

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
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}

function boundedRandom(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('random() must return [0,1)')
  return value
}

function sanitizedError(error: unknown, account: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? 'sync failed'
  const redacted = firstLine
    .replaceAll(account, '[account]')
    .replace(/(?:oauth|access|refresh|client)[_-]?(?:token|secret)\s*[:=]\s*\S+/gi, '[credential redacted]')
    .replace(/(?:[A-Za-z]:\\|\/)\S+/g, '[path]')
  return redacted.slice(0, 240) || 'sync failed'
}

/**
 * One process-local scheduler. Account timers are armed only after the prior
 * run (and one coalesced follow-up) has completed; setInterval is never used.
 */
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
  #heartbeat: unknown | null = null
  #heartbeatDueAt: number | null = null
  #resumeWave: Promise<void> | null = null

  constructor(deps: MsgvaultSyncSupervisorDependencies, options: MsgvaultSyncSupervisorOptions = {}) {
    this.#deps = deps
    this.#activeIntervalMs = finitePositive(options.activeIntervalMs ?? ACTIVE_SYNC_INTERVAL_MS, 'activeIntervalMs')
    this.#activeJitterFraction = options.activeJitterFraction ?? ACTIVE_SYNC_JITTER_FRACTION
    if (!Number.isFinite(this.#activeJitterFraction) || this.#activeJitterFraction < 0 || this.#activeJitterFraction > 1) {
      throw new Error('activeJitterFraction must be between 0 and 1')
    }
    this.#idleMinMs = finitePositive(options.idleMinMs ?? IDLE_SYNC_MIN_MS, 'idleMinMs')
    this.#idleMaxMs = finitePositive(options.idleMaxMs ?? IDLE_SYNC_MAX_MS, 'idleMaxMs')
    if (this.#idleMaxMs < this.#idleMinMs) throw new Error('idleMaxMs must be >= idleMinMs')
    this.#idleAfterEmptyRuns = Math.floor(finitePositive(options.idleAfterEmptyRuns ?? IDLE_AFTER_EMPTY_RUNS, 'idleAfterEmptyRuns'))
    this.#heartbeatMs = finitePositive(options.heartbeatMs ?? SUSPEND_HEARTBEAT_MS, 'heartbeatMs')
    this.#suspendLateAfterMs = finitePositive(options.suspendLateAfterMs ?? SUSPEND_LATE_AFTER_MS, 'suspendLateAfterMs')
  }

  async start(): Promise<void> {
    if (this.#started) return
    if (this.#stopping) throw new Error('sync supervisor is stopping')
    this.#started = true
    try {
      await this.#refreshAccounts()
      for (const state of this.#accounts.values()) this.#schedule(state, 0)
      this.#scheduleHeartbeat()
    } catch (error) {
      this.#started = false
      throw error
    }
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

  async stop(): Promise<void> {
    if (this.#stopping) {
      await Promise.all([...this.#accounts.values()].map((state) => state.inFlight).filter(Boolean))
      return
    }
    this.#stopping = true
    if (this.#heartbeat !== null) this.#deps.clearTimeout(this.#heartbeat)
    this.#heartbeat = null
    this.#heartbeatDueAt = null
    for (const state of this.#accounts.values()) {
      if (state.timer !== null) this.#deps.clearTimeout(state.timer)
      state.timer = null
      state.nextRunAt = null
      state.followUp = false
    }
    if (this.#resumeWave) await this.#resumeWave.catch(() => undefined)
    await Promise.all([...this.#accounts.values()].map((state) => state.inFlight).filter(Boolean))
  }

  #activeDelay(): number {
    const random = boundedRandom(this.#deps.random())
    return Math.round(this.#activeIntervalMs * (1 - this.#activeJitterFraction + 2 * this.#activeJitterFraction * random))
  }

  #idleDelay(): number {
    return Math.round(this.#idleMinMs + (this.#idleMaxMs - this.#idleMinMs) * boundedRandom(this.#deps.random()))
  }

  #nextDelay(state: AccountState): number {
    return state.consecutiveEmpty >= this.#idleAfterEmptyRuns ? this.#idleDelay() : this.#activeDelay()
  }

  #schedule(state: AccountState, delayMs: number): void {
    if (this.#stopping || state.removed) return
    if (state.timer !== null) this.#deps.clearTimeout(state.timer)
    state.nextRunAt = this.#deps.now() + delayMs
    state.timer = this.#deps.setTimeout(() => {
      state.timer = null
      state.nextRunAt = null
      void this.#request(state)
    }, delayMs)
  }

  #request(state: AccountState): Promise<void> {
    if (this.#stopping || state.removed) return Promise.resolve()
    if (state.timer !== null) this.#deps.clearTimeout(state.timer)
    state.timer = null
    state.nextRunAt = null
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
          state.lastError = sanitizedError(error, state.account)
        }
      } while (state.followUp && !this.#stopping && !state.removed)
    })()
    state.inFlight = work.finally(() => {
      state.inFlight = null
      if (!this.#stopping && !state.removed) this.#schedule(state, this.#nextDelay(state))
      else if (state.removed) this.#accounts.delete(state.account)
    })
    return state.inFlight
  }

  async #refreshAccounts(): Promise<void> {
    const discovered = await this.#deps.discoverAccounts()
    const active = new Set(discovered)
    for (const account of discovered) {
      if (this.#accounts.has(account)) {
        this.#accounts.get(account)!.removed = false
        continue
      }
      this.#accounts.set(account, {
        account,
        timer: null,
        nextRunAt: null,
        inFlight: null,
        followUp: false,
        consecutiveEmpty: 0,
        lastSuccessAt: null,
        lastError: null,
        removed: false,
      })
    }
    for (const state of this.#accounts.values()) {
      if (active.has(state.account)) continue
      state.removed = true
      if (state.timer !== null) this.#deps.clearTimeout(state.timer)
      state.timer = null
      state.nextRunAt = null
      if (!state.inFlight) this.#accounts.delete(state.account)
    }
  }

  #scheduleHeartbeat(): void {
    if (this.#stopping) return
    this.#heartbeatDueAt = this.#deps.now() + this.#heartbeatMs
    this.#heartbeat = this.#deps.setTimeout(() => {
      this.#heartbeat = null
      const lateBy = this.#deps.now() - (this.#heartbeatDueAt ?? this.#deps.now())
      this.#heartbeatDueAt = null
      this.#scheduleHeartbeat()
      if (lateBy >= this.#suspendLateAfterMs) this.#requestResumeWave()
    }, this.#heartbeatMs)
  }

  #requestResumeWave(): void {
    if (this.#stopping || this.#resumeWave) return
    this.#resumeWave = (async () => {
      await this.#refreshAccounts()
      await Promise.all([...this.#accounts.values()].filter((state) => !state.removed).map((state) => this.#request(state)))
    })().catch((error) => {
      for (const state of this.#accounts.values()) state.lastError = sanitizedError(error, state.account)
    }).finally(() => { this.#resumeWave = null })
  }
}
