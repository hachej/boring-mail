/** Dedicated DatabaseSync owner. Loaded as emitted mailStoreWorker.js. */
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { openMsgvaultStore, resolveReplyTarget } from '../msgvaultAdapter.js'
import { acquireDataDirectoryLock, type DataDirectoryLock } from './dataDirectoryLock.js'
import { ProductStore } from './ProductStore.js'
import type {
  MailStoreWorkerConfig,
  RpcHandlers,
  RpcRequest,
  RpcResponse,
  SerializedError,
} from './mailStoreProtocol.js'
import { ProductStoreError } from './types.js'

if (!parentPort) throw new Error('mailStoreWorker must run in a worker thread')
const port = parentPort

function serialized(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error instanceof ProductStoreError ? { code: error.code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  return { name: 'Error', message: String(error) }
}

async function start(): Promise<void> {
  let lock: DataDirectoryLock | null = null
  let vault: ReturnType<typeof openMsgvaultStore> | null = null
  let store: ProductStore | null = null
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    store?.close()
    store = null
    vault?.db.close()
    vault = null
    await lock?.release()
    lock = null
  }
  try {
    const config = workerData as MailStoreWorkerConfig
    if (!config?.productDbPath) throw new Error('productDbPath is required')
    // D8: lock precedes every archive/database open and every migration.
    lock = await acquireDataDirectoryLock(dirname(config.productDbPath))
    vault = config.msgvaultDbPath ? openMsgvaultStore(config.msgvaultDbPath) : null
    store = ProductStore.open(config.productDbPath, {
      now: Date.now,
      resolveReplyTarget: (messageId) => vault ? resolveReplyTarget(vault.db, messageId) : null,
    })
    const productStore = store
    const handlers: RpcHandlers = {
      upsertAccount: (input) => productStore.upsertAccount(input),
      saveDraft: (input, id) => productStore.saveDraft(input, id),
      getDraft: (id) => productStore.getDraft(id),
      getOutbox: (id) => productStore.outbox.get(id),
      listAttention: (openOnly) => productStore.outbox.listAttention(openOnly),
      enqueue: (draftId, key) => productStore.outbox.enqueue(draftId, key),
      issueApprovalCapability: (id, session, ttl) => productStore.outbox.issueApprovalCapability(id, session, ttl),
      approve: (id, token, session) => productStore.outbox.approve(id, token, session),
      reject: (id) => productStore.outbox.reject(id),
      claim: (id, worker, lease) => productStore.outbox.claim(id, worker, lease),
      claimNext: (worker, lease) => productStore.outbox.claimNext(worker, lease),
      markDispatched: (id, worker, history) => productStore.outbox.markDispatched(id, worker, history),
      markSent: (id, worker, provider) => productStore.outbox.markSent(id, worker, provider),
      markFailed: (id, worker, code, detail) => productStore.outbox.markFailed(id, worker, code, detail),
      markUnknown: (id, worker, detail, deadline) => productStore.outbox.markUnknown(id, worker, detail, deadline),
      cancel: (id) => productStore.outbox.cancel(id),
      recoverExpired: () => productStore.outbox.recoverExpired(),
      dueReconciliations: (limit) => productStore.outbox.dueReconciliations(limit),
      reconciliationFound: (id, provider) => productStore.outbox.reconciliationFound(id, provider),
      reconciliationMiss: (id, backoff) => productStore.outbox.reconciliationMiss(id, backoff),
      keepWaiting: (id, duration) => productStore.outbox.keepWaiting(id, duration),
      markHumanSent: (id) => productStore.outbox.markHumanSent(id),
      retry: (id, key) => productStore.outbox.retry(id, key),
      close,
    }
    port.postMessage({ type: 'ready' } satisfies RpcResponse)
    port.on('message', (request: RpcRequest) => {
      void (async () => {
        try {
          // Handler map is checked against the protocol above; this cast is the
          // structured-clone boundary where the discriminated request is erased.
          const invoke = handlers[request.method] as (...args: unknown[]) => unknown
          const value = await invoke(...request.args)
          port.postMessage({ type: 'response', id: request.id, value } satisfies RpcResponse)
        } catch (error) {
          port.postMessage({ type: 'response', id: request.id, error: serialized(error) } satisfies RpcResponse)
        }
      })()
    })
  } catch (error) {
    await close().catch(() => undefined)
    port.postMessage({ type: 'ready', error: serialized(error) } satisfies RpcResponse)
  }
}

void start()
