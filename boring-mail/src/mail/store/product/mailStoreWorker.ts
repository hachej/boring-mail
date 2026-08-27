/** Dedicated DatabaseSync owner, run as an emitted child process in production. */
import { randomUUID } from 'node:crypto'
import {
  fstatSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { listUnifiedInbox, openMsgvaultStore, resolveReplyTarget } from '../msgvaultAdapter.js'
import { ProductStore } from './ProductStore.js'
import type {
  MailStoreWorkerConfig,
  RpcHandlers,
  RpcRequest,
  RpcResponse,
  SerializedError,
} from './mailStoreProtocol.js'
import { ProductStoreError } from './types.js'

if (!process.send) throw new Error('mailStoreWorker requires child-process IPC')
const send = (message: RpcResponse): void => {
  // A dead parent closes IPC before a synchronous handler can observe its
  // disconnect event. Dropping that final response lets disconnect fail-stop.
  process.send?.(message)
}
const onRequest = (listener: (request: RpcRequest) => void): void => {
  process.on('message', (message) => listener(message as RpcRequest))
}
const closeChannel = (): void => {
  if (process.connected) process.disconnect()
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
  let ownerMetadataPath: string | null = null
  let lockedIdentity: { directoryDev: number; directoryIno: number; databaseDev: number; databaseIno: number } | null = null
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
    {
      const dataDirectory = process.env.BORING_MAIL_DATA_DIRECTORY
      const ownerPath = process.env.BORING_MAIL_OWNER_METADATA_PATH
      const directoryFd = Number(process.env.BORING_MAIL_DIRECTORY_LOCK_FD)
      const databaseFd = Number(process.env.BORING_MAIL_DATABASE_LOCK_FD)
      if (!dataDirectory || !ownerPath || !Number.isSafeInteger(directoryFd) || directoryFd < 0 ||
          !Number.isSafeInteger(databaseFd) || databaseFd < 0) {
        throw new Error('mail store lock environment is incomplete')
      }
      // The shell locked both inherited fds and exec'd this process. Verify the
      // canonical directory and database inode identities under those locks.
      const heldDirectory = fstatSync(directoryFd)
      const namedDirectory = statSync(dataDirectory)
      const heldDatabase = fstatSync(databaseFd)
      const namedDatabase = statSync(config.productDbPath)
      if (!heldDirectory.isDirectory() || !namedDirectory.isDirectory() ||
          heldDirectory.dev !== namedDirectory.dev || heldDirectory.ino !== namedDirectory.ino) {
        throw new ProductStoreError('invalid_input', 'mail store data-directory identity changed during acquisition')
      }
      if (!heldDatabase.isFile() || !namedDatabase.isFile() || heldDatabase.nlink !== 1 ||
          heldDatabase.dev !== namedDatabase.dev || heldDatabase.ino !== namedDatabase.ino) {
        throw new ProductStoreError('invalid_input', 'mail store database identity changed during acquisition')
      }
      lockedIdentity = {
        directoryDev: heldDirectory.dev,
        directoryIno: heldDirectory.ino,
        databaseDev: heldDatabase.dev,
        databaseIno: heldDatabase.ino,
      }
      ownerMetadataPath = ownerPath
    }
    // Open SQLite immediately after inode verification while both inherited
    // locks are held. Revalidate the pathname after open before any slower
    // msgvault/schema work or readiness signal can create a TOCTOU window.
    store = ProductStore.open(config.productDbPath, {
      now: Date.now,
      resolveReplyTarget: (messageId) => vault ? resolveReplyTarget(vault.db, messageId) : null,
    })
    assertCanonicalDatabasePath(config.productDbPath)
    if (lockedIdentity) {
      const directoryAfterOpen = statSync(dirname(config.productDbPath))
      const databaseAfterOpen = statSync(config.productDbPath)
      if (directoryAfterOpen.dev !== lockedIdentity.directoryDev ||
          directoryAfterOpen.ino !== lockedIdentity.directoryIno ||
          databaseAfterOpen.dev !== lockedIdentity.databaseDev ||
          databaseAfterOpen.ino !== lockedIdentity.databaseIno) {
        throw new ProductStoreError('invalid_input', 'mail store path identity changed while opening SQLite')
      }
    }
    if (ownerMetadataPath) {
      const metadata = JSON.stringify({
        pid: process.pid,
        processStartedAt: new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString(),
      }) + '\n'
      const temporaryOwnerPath = `${ownerMetadataPath}.${process.pid}.tmp`
      try {
        writeFileSync(temporaryOwnerPath, metadata, { flag: 'wx', mode: 0o600 })
        renameSync(temporaryOwnerPath, ownerMetadataPath)
      } finally {
        rmSync(temporaryOwnerPath, { force: true })
      }
    }
    vault = config.msgvaultDbPath ? openMsgvaultStore(config.msgvaultDbPath) : null
    const productStore = store
    const cursorAuthority = { scope: randomUUID() }
    const handlers: RpcHandlers = {
      upsertAccount: (input) => productStore.upsertAccount(input),
      saveDraft: (input, id) => productStore.saveDraft(input, id),
      getDraft: (id) => productStore.getDraft(id),
      listUnifiedInbox: (options) => {
        if (!vault) {
          throw new ProductStoreError(
            'msgvault_unavailable',
            'REMEDIATION: configure msgvaultDbPath before listing the unified inbox',
          )
        }
        return listUnifiedInbox(
          vault.db,
          productStore.connectedInboxSources(),
          cursorAuthority,
          options,
        )
      },
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
    process.once('disconnect', () => {
      close()
      process.exit(0)
    })
    process.once('SIGTERM', () => {
      close()
      closeChannel()
      process.exit(0)
    })
  } catch (error) {
    close()
    send({ type: 'ready', error: serialized(error) })
  }
}

void start()
