import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  AccountInput,
  ApprovedOutbox,
  AttentionItem,
  CancelledOutbox,
  ClaimedOutbox,
  DispatchedOutbox,
  DraftInput,
  DraftRecord,
  FailedOutbox,
  HumanDecisionOutbox,
  OutboxRecord,
  RejectedOutbox,
  SentOutbox,
  UnknownOutbox,
} from './types.js'
import { ProductStoreError, type ProductStoreErrorCode } from './types.js'
import type {
  MailStoreMethod,
  MailStoreMethods,
  MailStoreWorkerConfig,
  RpcRequest,
  RpcResponse,
  SerializedError,
} from './mailStoreProtocol.js'

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_PENDING_REQUESTS = 100
const MAX_TIMER_MS = 2_147_483_647

export interface WorkerTransport {
  postMessage(value: unknown): void
  on(event: 'message', listener: (value: RpcResponse) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}
export type MailStoreWorkerFactory = (config: MailStoreWorkerConfig) => WorkerTransport
export interface MailStoreOpenOptions {
  workerFactory?: MailStoreWorkerFactory
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  maxPendingRequests?: number
}

export interface AsyncOutboxStore {
  get(id: string): Promise<OutboxRecord | null>
  listAttention(openOnly?: boolean): Promise<AttentionItem[]>
  enqueue(draftId: string, operationKey: string): Promise<OutboxRecord>
  issueApprovalCapability(id: string, sessionId: string, ttlMs?: number): Promise<string>
  approve(id: string, token: string, sessionId: string): Promise<ApprovedOutbox>
  reject(id: string): Promise<RejectedOutbox>
  claim(id: string, workerId: string, leaseMs?: number): Promise<ClaimedOutbox>
  claimNext(workerId: string, leaseMs?: number): Promise<ClaimedOutbox | null>
  markDispatched(id: string, workerId: string, preDispatchHistoryId: string): Promise<DispatchedOutbox>
  markSent(id: string, workerId: string, providerMessageId: string): Promise<SentOutbox>
  markFailed(id: string, workerId: string, code: string, detail: string): Promise<FailedOutbox>
  markUnknown(id: string, workerId: string, detail: string, deadlineMs?: number): Promise<UnknownOutbox>
  cancel(id: string): Promise<CancelledOutbox>
  recoverExpired(): Promise<UnknownOutbox[]>
  dueReconciliations(limit?: number): Promise<UnknownOutbox[]>
  reconciliationFound(id: string, providerMessageId: string): Promise<SentOutbox>
  reconciliationMiss(id: string, backoffMs: number): Promise<UnknownOutbox | HumanDecisionOutbox>
  keepWaiting(id: string, durationMs?: number): Promise<UnknownOutbox>
  markHumanSent(id: string): Promise<SentOutbox>
  retry(id: string, operationKey: string): Promise<OutboxRecord>
}
export interface MailStore {
  readonly outbox: AsyncOutboxStore
  upsertAccount(input: AccountInput): Promise<void>
  saveDraft(input: DraftInput, requestedId?: string): Promise<DraftRecord>
  getDraft(id: string): Promise<DraftRecord | null>
  close(): Promise<void>
}

interface RpcLimits {
  startupTimeoutMs: number
  requestTimeoutMs: number
  maxPendingRequests: number
}
interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** mailStoreWorker.js is emitted adjacent to this compiled public module. */
function defaultWorker(config: MailStoreWorkerConfig): WorkerTransport {
  return new Worker(new URL('./mailStoreWorker.js', import.meta.url), {
    workerData: config,
    // node:sqlite is intentionally isolated here; suppress its Node 22
    // ExperimentalWarning only in this emitted storage worker.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  })
}
function remoteError(error: SerializedError): Error {
  if (error.code) {
    const typed = new ProductStoreError(error.code as ProductStoreErrorCode, error.message)
    if (error.stack) typed.stack = error.stack
    return typed
  }
  const generic = new Error(error.message)
  generic.name = error.name
  if (error.stack) generic.stack = error.stack
  return generic
}

class RpcClient {
  readonly ready: Promise<void>
  #readyResolve!: () => void
  #readyReject!: (error: Error) => void
  #startupTimer: ReturnType<typeof setTimeout>
  #nextId = 1
  #pending = new Map<number, PendingCall>()
  #stopped = false
  #termination: Promise<void> | null = null

  constructor(
    readonly worker: WorkerTransport,
    private readonly limits: RpcLimits,
    private readonly onFailure: (error: Error) => void,
  ) {
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.#readyResolve = resolveReady
      this.#readyReject = rejectReady
    })
    this.#startupTimer = setTimeout(() => {
      this.#fail(new ProductStoreError('rpc_timeout', 'mail store worker startup timed out'))
    }, limits.startupTimeoutMs)
    this.#startupTimer.unref()
    worker.on('message', (message) => this.#message(message))
    worker.on('error', (error) => this.#fail(error))
    worker.on('exit', (code) => {
      if (!this.#stopped) this.#fail(new Error(`mail store worker exited unexpectedly with code ${code}`))
    })
  }

  #message(message: RpcResponse): void {
    if (message.type === 'ready') {
      clearTimeout(this.#startupTimer)
      if ('error' in message) this.#fail(remoteError(message.error))
      else this.#readyResolve()
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if ('error' in message) pending.reject(remoteError(message.error))
    else pending.resolve(message.value)
  }

  #fail(error: Error): void {
    if (this.#stopped) return
    this.#stopped = true
    clearTimeout(this.#startupTimer)
    this.#readyReject(error)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.onFailure(error)
  }

  async call<M extends MailStoreMethod>(
    method: M,
    ...args: Parameters<MailStoreMethods[M]>
  ): Promise<ReturnType<MailStoreMethods[M]>> {
    await this.ready
    if (this.#stopped) throw new Error('mail store worker is closed')
    if (this.#pending.size >= this.limits.maxPendingRequests) {
      throw new ProductStoreError(
        'rpc_overloaded',
        `mail store has ${this.#pending.size} pending requests (limit ${this.limits.maxPendingRequests})`,
      )
    }
    const id = this.#nextId++
    const result = new Promise<unknown>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.#fail(new ProductStoreError('rpc_timeout', `mail store request timed out: ${String(method)}`))
      }, this.limits.requestTimeoutMs)
      timer.unref()
      this.#pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
      try {
        this.worker.postMessage({ id, method, args } as RpcRequest)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        rejectCall(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return await result as ReturnType<MailStoreMethods[M]>
  }

  async terminate(): Promise<void> {
    if (!this.#termination) {
      this.#termination = this.worker.terminate().then(() => undefined, () => undefined)
    }
    await this.#termination
  }

  async shutdown(): Promise<void> {
    try {
      if (!this.#stopped) await this.call('close')
    } finally {
      if (!this.#stopped) {
        this.#stopped = true
        clearTimeout(this.#startupTimer)
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error('mail store worker is closing'))
        }
        this.#pending.clear()
      }
      await this.terminate()
    }
  }
}

type RegistryState = 'starting' | 'ready' | 'closing' | 'dead'
interface RegistryEntry {
  config: MailStoreWorkerConfig
  limits: RpcLimits
  factory: MailStoreWorkerFactory
  rpc: RpcClient
  references: number
  state: RegistryState
  disposal: Promise<void> | null
}
const registry = new Map<string, RegistryEntry>()

function positiveOption(value: number | undefined, fallback: number, name: string, maximum = MAX_TIMER_MS): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new ProductStoreError('invalid_input', `${name} must be a positive safe integer no greater than ${maximum}`)
  }
  return selected
}
function limits(options: MailStoreOpenOptions): RpcLimits {
  return {
    startupTimeoutMs: positiveOption(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs'),
    requestTimeoutMs: positiveOption(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs'),
    maxPendingRequests: positiveOption(options.maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS, 'maxPendingRequests'),
  }
}
function canonicalConfig(config: MailStoreWorkerConfig): MailStoreWorkerConfig {
  if (!config.productDbPath) throw new ProductStoreError('invalid_input', 'productDbPath is required')
  const absolute = resolve(config.productDbPath)
  let directory: string
  try {
    directory = realpathSync.native(dirname(absolute))
  } catch {
    throw new ProductStoreError('invalid_input', 'product database directory must already exist')
  }
  return {
    productDbPath: join(directory, basename(absolute)),
    ...(config.msgvaultDbPath ? { msgvaultDbPath: resolve(config.msgvaultDbPath) } : {}),
  }
}
function sameConfig(left: MailStoreWorkerConfig, right: MailStoreWorkerConfig): boolean {
  return left.productDbPath === right.productDbPath && left.msgvaultDbPath === right.msgvaultDbPath
}
function sameLimits(left: RpcLimits, right: RpcLimits): boolean {
  return left.startupTimeoutMs === right.startupTimeoutMs &&
    left.requestTimeoutMs === right.requestTimeoutMs &&
    left.maxPendingRequests === right.maxPendingRequests
}

function beginDisposal(key: string, entry: RegistryEntry, graceful: boolean): Promise<void> {
  if (entry.disposal) return entry.disposal
  entry.state = 'closing'
  const dispose = graceful ? entry.rpc.shutdown() : entry.rpc.terminate()
  // Disposal is a barrier, not an error channel; operation/startup promises
  // already carry the original failure. Reopens must proceed after teardown.
  entry.disposal = dispose.catch(() => undefined).finally(() => {
    entry.state = 'dead'
    if (registry.get(key) === entry) registry.delete(key)
  })
  return entry.disposal
}

function createEntry(
  key: string,
  config: MailStoreWorkerConfig,
  selectedLimits: RpcLimits,
  factory: MailStoreWorkerFactory,
): RegistryEntry {
  let entry!: RegistryEntry
  const rpc = new RpcClient(factory(config), selectedLimits, () => {
    // Keep a closing tombstone until termination has completed.
    queueMicrotask(() => { void beginDisposal(key, entry, false) })
  })
  entry = {
    config,
    limits: selectedLimits,
    factory,
    rpc,
    references: 0,
    state: 'starting',
    disposal: null,
  }
  registry.set(key, entry)
  return entry
}

class MailStoreFacade implements MailStore {
  readonly outbox: AsyncOutboxStore
  #closed = false
  constructor(private readonly key: string, private readonly entry: RegistryEntry) {
    const call = <M extends MailStoreMethod>(
      method: M, ...args: Parameters<MailStoreMethods[M]>
    ): Promise<ReturnType<MailStoreMethods[M]>> => this.call(method, ...args)
    this.outbox = {
      get: (id) => call('getOutbox', id),
      listAttention: (openOnly) => call('listAttention', openOnly),
      enqueue: (draft, operation) => call('enqueue', draft, operation),
      issueApprovalCapability: (id, session, ttl) => call('issueApprovalCapability', id, session, ttl),
      approve: (id, token, session) => call('approve', id, token, session),
      reject: (id) => call('reject', id),
      claim: (id, worker, lease) => call('claim', id, worker, lease),
      claimNext: (worker, lease) => call('claimNext', worker, lease),
      markDispatched: (id, worker, history) => call('markDispatched', id, worker, history),
      markSent: (id, worker, provider) => call('markSent', id, worker, provider),
      markFailed: (id, worker, code, detail) => call('markFailed', id, worker, code, detail),
      markUnknown: (id, worker, detail, deadline) => call('markUnknown', id, worker, detail, deadline),
      cancel: (id) => call('cancel', id),
      recoverExpired: () => call('recoverExpired'),
      dueReconciliations: (limit) => call('dueReconciliations', limit),
      reconciliationFound: (id, provider) => call('reconciliationFound', id, provider),
      reconciliationMiss: (id, backoff) => call('reconciliationMiss', id, backoff),
      keepWaiting: (id, duration) => call('keepWaiting', id, duration),
      markHumanSent: (id) => call('markHumanSent', id),
      retry: (id, operation) => call('retry', id, operation),
    }
  }
  private async call<M extends MailStoreMethod>(
    method: M, ...args: Parameters<MailStoreMethods[M]>
  ): Promise<ReturnType<MailStoreMethods[M]>> {
    if (this.#closed) throw new Error('MailStore reference is closed')
    return this.entry.rpc.call(method, ...args)
  }
  upsertAccount(input: AccountInput): Promise<void> { return this.call('upsertAccount', input) }
  saveDraft(input: DraftInput, requestedId?: string): Promise<DraftRecord> {
    return this.call('saveDraft', input, requestedId)
  }
  getDraft(id: string): Promise<DraftRecord | null> { return this.call('getDraft', id) }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.entry.references--
    if (this.entry.references === 0) await beginDisposal(this.key, this.entry, true)
  }
}

/** Open/share one dedicated SQLite worker for the canonical product DB directory. */
export async function openMailStore(
  input: MailStoreWorkerConfig,
  options: MailStoreOpenOptions = {},
): Promise<MailStore> {
  const config = canonicalConfig(input)
  const selectedLimits = limits(options)
  const factory = options.workerFactory ?? defaultWorker
  const key = dirname(config.productDbPath)
  for (;;) {
    let entry = registry.get(key)
    if (entry?.state === 'closing' || entry?.state === 'dead') {
      await entry.disposal
      continue
    }
    if (entry) {
      if (!sameConfig(entry.config, config)) {
        throw new ProductStoreError('invalid_input', 'mail store directory is already open with different database config')
      }
      if (!sameLimits(entry.limits, selectedLimits) || entry.factory !== factory) {
        throw new ProductStoreError('invalid_input', 'mail store directory is already open with different RPC settings')
      }
    } else {
      entry = createEntry(key, config, selectedLimits, factory)
    }

    // Reserve synchronously before readiness can race a last-close disposal.
    entry.references++
    try {
      await entry.rpc.ready
      if (entry.state === 'starting') entry.state = 'ready'
      if (entry.state !== 'ready') throw new Error('mail store worker became unavailable during startup')
      return new MailStoreFacade(key, entry)
    } catch (error) {
      entry.references--
      if (!entry.disposal) void beginDisposal(key, entry, false)
      throw error
    }
  }
}
