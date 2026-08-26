/** Dedicated DatabaseSync owner, run as an emitted child process in production. */
import {
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
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

const processMode = parentPort === null
const send = (message: RpcResponse): void => {
  if (parentPort) parentPort.postMessage(message)
  else if (process.send) process.send(message)
  // A dead parent closes IPC before the synchronous handler can observe its
  // disconnect event. Dropping that final response lets disconnect fail-stop.
  else if (!processMode) throw new Error('mailStoreWorker requires worker-thread or process IPC')
}
const onRequest = (listener: (request: RpcRequest) => void): void => {
  if (parentPort) parentPort.on('message', listener)
  else process.on('message', (message) => listener(message as RpcRequest))
}
const closeChannel = (): void => {
  if (parentPort) parentPort.close()
  else if (process.connected) process.disconnect()
}

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

function configFromRuntime(): MailStoreWorkerConfig {
  if (!processMode) return workerData as MailStoreWorkerConfig
  const raw = process.env.BORING_MAIL_WORKER_CONFIG
  if (!raw) throw new Error('BORING_MAIL_WORKER_CONFIG is required')
  return JSON.parse(raw) as MailStoreWorkerConfig
}

/** Re-check final-component identity after the canonical-directory flock is held. */
function assertCanonicalDatabasePath(path: string): void {
  if (realpathSync.native(dirname(path)) !== dirname(path)) {
    throw new ProductStoreError('invalid_input', 'product database parent is not canonical')
  }
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry) return
  if (entry.isSymbolicLink() || !entry.isFile() || statSync(path).nlink !== 1) {
    throw new ProductStoreError(
      'invalid_input',
      'product database must be absent or an existing non-symlink regular file with one hard link',
    )
  }
}

async function start(): Promise<void> {
  let vault: ReturnType<typeof openMsgvaultStore> | null = null
  let store: ProductStore | null = null
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    store?.close()
    store = null
    vault?.db.close()
    vault = null
  }
  try {
    const config = configFromRuntime()
    if (!config?.productDbPath) throw new Error('productDbPath is required')
    assertCanonicalDatabasePath(config.productDbPath)
    if (processMode) {
      const lockPath = process.env.BORING_MAIL_LOCK_PATH
      const lockFd = Number(process.env.BORING_MAIL_LOCK_FD)
      if (!lockPath || !Number.isSafeInteger(lockFd) || lockFd < 0) {
        throw new Error('BORING_MAIL_LOCK_PATH and BORING_MAIL_LOCK_FD are required')
      }
      // This process is already executing under flock --no-fork. Verify that
      // the inherited O_NOFOLLOW descriptor still names the reserved path,
      // then write metadata through that descriptor—never reopen the pathname.
      const held = fstatSync(lockFd)
      const named = lstatSync(lockPath, { throwIfNoEntry: false })
      if (!named || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1 ||
          held.dev !== named.dev || held.ino !== named.ino) {
        throw new ProductStoreError('invalid_input', 'mail store lock pathname changed during acquisition')
      }
      const metadata = JSON.stringify({
        pid: process.pid,
        processStartedAt: new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString(),
      }) + '\n'
      ftruncateSync(lockFd, 0)
      writeSync(lockFd, metadata, 0, 'utf8')
      fsyncSync(lockFd)
    }
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
    send({ type: 'ready' })
    onRequest((request) => {
      void (async () => {
        try {
          const invoke = handlers[request.method] as (...args: unknown[]) => unknown
          const value = await invoke(...request.args)
          send({ type: 'response', id: request.id, value })
        } catch (error) {
          send({ type: 'response', id: request.id, error: serialized(error) })
        }
      })()
    })
    if (processMode) {
      process.once('disconnect', () => {
        close()
        process.exit(0)
      })
      process.once('SIGTERM', () => {
        close()
        closeChannel()
        process.exit(0)
      })
    }
  } catch (error) {
    close()
    send({ type: 'ready', error: serialized(error) })
  }
}

void start()
