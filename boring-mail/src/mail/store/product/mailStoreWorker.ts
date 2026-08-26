/** Dedicated DatabaseSync owner. Loaded as emitted mailStoreWorker.js. */
import { parentPort, workerData } from 'node:worker_threads'
import { openMsgvaultStore, resolveReplyTarget } from '../msgvaultAdapter.js'
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

try {
  const config = workerData as MailStoreWorkerConfig
  if (!config?.productDbPath) throw new Error('productDbPath is required')
  const vault = config.msgvaultDbPath ? openMsgvaultStore(config.msgvaultDbPath) : null
  const store = ProductStore.open(config.productDbPath, {
    now: Date.now,
    resolveReplyTarget: (messageId) => vault ? resolveReplyTarget(vault.db, messageId) : null,
  })
  const handlers: RpcHandlers = {
    upsertAccount: (input) => store.upsertAccount(input),
    saveDraft: (input, id) => store.saveDraft(input, id),
    getDraft: (id) => store.getDraft(id),
    getOutbox: (id) => store.outbox.get(id),
    listAttention: (openOnly) => store.outbox.listAttention(openOnly),
    enqueue: (draftId, key) => store.outbox.enqueue(draftId, key),
    issueApprovalCapability: (id, session, ttl) => store.outbox.issueApprovalCapability(id, session, ttl),
    approve: (id, token, session) => store.outbox.approve(id, token, session),
    reject: (id) => store.outbox.reject(id),
    claim: (id, worker, lease) => store.outbox.claim(id, worker, lease),
    claimNext: (worker, lease) => store.outbox.claimNext(worker, lease),
    markDispatched: (id, worker, history) => store.outbox.markDispatched(id, worker, history),
    markSent: (id, worker, provider) => store.outbox.markSent(id, worker, provider),
    markFailed: (id, worker, code, detail) => store.outbox.markFailed(id, worker, code, detail),
    markUnknown: (id, worker, detail, deadline) => store.outbox.markUnknown(id, worker, detail, deadline),
    cancel: (id) => store.outbox.cancel(id),
    recoverExpired: () => store.outbox.recoverExpired(),
    dueReconciliations: (limit) => store.outbox.dueReconciliations(limit),
    reconciliationFound: (id, provider) => store.outbox.reconciliationFound(id, provider),
    reconciliationMiss: (id, backoff) => store.outbox.reconciliationMiss(id, backoff),
    keepWaiting: (id, duration) => store.outbox.keepWaiting(id, duration),
    markHumanSent: (id) => store.outbox.markHumanSent(id),
    retry: (id, key) => store.outbox.retry(id, key),
    close: () => {
      store.close()
      vault?.db.close()
    },
  }
  port.postMessage({ type: 'ready' } satisfies RpcResponse)
  port.on('message', (request: RpcRequest) => {
    try {
      // Handler map is checked against the protocol above; this cast is the
      // structured-clone boundary where the discriminated request is erased.
      const invoke = handlers[request.method] as (...args: unknown[]) => unknown
      const value = invoke(...request.args)
      port.postMessage({ type: 'response', id: request.id, value } satisfies RpcResponse)
    } catch (error) {
      port.postMessage({ type: 'response', id: request.id, error: serialized(error) } satisfies RpcResponse)
    }
  })
} catch (error) {
  port.postMessage({ type: 'ready', error: serialized(error) } satisfies RpcResponse)
}
