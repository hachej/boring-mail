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

export interface WorkerTransport {
  postMessage(value: unknown): void
  on(event: 'message', listener: (value: RpcResponse) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}
export type MailStoreWorkerFactory = (config: MailStoreWorkerConfig) => WorkerTransport
export interface MailStoreOpenOptions { workerFactory?: MailStoreWorkerFactory }

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

/**
 * The package/server build emits mailStoreWorker.ts beside this module as
 * mailStoreWorker.js. Keeping a normal emitted-JS URL avoids runtime TS loaders.
 */
function defaultWorker(config: MailStoreWorkerConfig): WorkerTransport {
  return new Worker(new URL('./mailStoreWorker.js', import.meta.url), { workerData: config })
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
  #nextId = 1
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  #stopped = false
  constructor(readonly worker: WorkerTransport, private readonly onStop: () => void) {
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.#readyResolve = resolveReady
      this.#readyReject = rejectReady
    })
    worker.on('message', (message) => this.#message(message))
    worker.on('error', (error) => this.#stop(error))
    worker.on('exit', (code) => {
      if (!this.#stopped) this.#stop(new Error(`mail store worker exited unexpectedly with code ${code}`))
    })
  }
  #message(message: RpcResponse): void {
    if (message.type === 'ready') {
      if ('error' in message) this.#readyReject(remoteError(message.error))
      else this.#readyResolve()
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    if ('error' in message) pending.reject(remoteError(message.error))
    else pending.resolve(message.value)
  }
  #stop(error: Error): void {
    if (this.#stopped) return
    this.#stopped = true
    this.onStop()
    this.#readyReject(error)
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
  async call<M extends MailStoreMethod>(
    method: M,
    ...args: Parameters<MailStoreMethods[M]>
  ): Promise<ReturnType<MailStoreMethods[M]>> {
    await this.ready
    if (this.#stopped) throw new Error('mail store worker is closed')
    const id = this.#nextId++
    const result = new Promise<unknown>((resolveCall, rejectCall) => {
      this.#pending.set(id, { resolve: resolveCall, reject: rejectCall })
      try {
        this.worker.postMessage({ id, method, args } as RpcRequest)
      } catch (error) {
        this.#pending.delete(id)
        rejectCall(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return await result as ReturnType<MailStoreMethods[M]>
  }
  async shutdown(): Promise<void> {
    if (this.#stopped) return
    try { await this.call('close') } finally {
      this.#stopped = true
      await this.worker.terminate()
    }
  }
}

interface RegistryEntry {
  config: MailStoreWorkerConfig
  rpc: RpcClient
  references: number
}
const registry = new Map<string, RegistryEntry>()
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
function compatible(left: MailStoreWorkerConfig, right: MailStoreWorkerConfig): boolean {
  return left.productDbPath === right.productDbPath && left.msgvaultDbPath === right.msgvaultDbPath
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
    if (this.entry.references === 0) {
      if (registry.get(this.key) === this.entry) registry.delete(this.key)
      await this.entry.rpc.shutdown()
    }
  }
}

/** Open/share one dedicated SQLite worker for the canonical product DB path. */
export async function openMailStore(
  input: MailStoreWorkerConfig,
  options: MailStoreOpenOptions = {},
): Promise<MailStore> {
  const config = canonicalConfig(input)
  const key = dirname(config.productDbPath)
  let entry = registry.get(key)
  if (entry && !compatible(entry.config, config)) {
    throw new ProductStoreError('invalid_input', 'mail store path is already open with different msgvault config')
  }
  if (!entry) {
    const factory = options.workerFactory ?? defaultWorker
    let rpc!: RpcClient
    rpc = new RpcClient(factory(config), () => {
      const current = registry.get(key)
      if (current?.rpc === rpc) registry.delete(key)
    })
    entry = { config, rpc, references: 0 }
    registry.set(key, entry)
  }
  try {
    await entry.rpc.ready
  } catch (error) {
    if (registry.get(key) === entry) registry.delete(key)
    await entry.rpc.worker.terminate().catch(() => 0)
    throw error
  }
  entry.references++
  return new MailStoreFacade(key, entry)
}
