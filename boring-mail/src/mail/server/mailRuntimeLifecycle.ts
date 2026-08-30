import { chmod, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { MailStore, MailStoreOpenOptions } from '../store/product/MailStore.ts'
import type { MailStoreWorkerConfig } from '../store/product/mailStoreProtocol.ts'
import { ProductStoreError } from '../store/product/types.ts'
import {
  acquireMsgvaultSyncRuntime,
  defaultMsgvaultDbPath,
  defaultMsgvaultHome,
  resolveMsgvaultArchive,
  type MsgvaultSyncRuntimeLease,
  type MsgvaultSyncRuntimeOptions,
} from '../sync/msgvaultSyncRuntime.ts'

export const MAIL_RUNTIME_STARTUP_TIMEOUT_MS = 5_000
export const MAIL_RUNTIME_READ_TIMEOUT_MS = 7_500

export interface MailRuntimeLogger {
  warn(fields: Record<string, unknown>, message?: string): void
  info?(fields: Record<string, unknown>, message?: string): void
  error?(fields: Record<string, unknown>, message?: string): void
}

export type OpenMailStore = (config: MailStoreWorkerConfig, options?: MailStoreOpenOptions) => Promise<MailStore>
type AcquireSyncRuntime = typeof acquireMsgvaultSyncRuntime

const defaultOpenMailStore: OpenMailStore = async (config, options) => {
  const { openMailStore } = await import('../store/product/MailStore.ts')
  return openMailStore(config, options)
}

export interface MailRuntimeLifecycleOptions {
  productDbPath?: string
  msgvaultDbPath?: string
  msgvaultHome?: string
  sync?: MsgvaultSyncRuntimeOptions | false
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  /** Allows fixture handlers to stay registered and typed-unavailable before a fixture DB exists. */
  tolerateMissingMsgvault?: boolean
  /** Validate fixture archives contain only synthetic .invalid identities before store open. */
  requireSyntheticFixture?: boolean
  openStore?: OpenMailStore
  acquireSync?: AcquireSyncRuntime
  logger?: MailRuntimeLogger
}

interface MailStoreGeneration {
  id: number
  store: MailStore
}

export type MailRuntimeReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'stale_cursor' }
  | { status: 'unavailable' }

export function defaultProductDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share')
  return resolve(dataHome, 'boring-mail', 'default', 'mail.db')
}

function isTypedUnavailable(error: unknown): error is ProductStoreError {
  return error instanceof ProductStoreError && (
    error.code === 'msgvault_unavailable' ||
    error.code === 'rpc_timeout' ||
    error.code === 'rpc_unavailable' ||
    error.code === 'rpc_overloaded' ||
    error.code === 'mail_store_already_active' ||
    error.code === 'corrupt_data' ||
    error.code === 'unsupported_schema'
  )
}

function requiresStoreRecovery(error: ProductStoreError): boolean {
  return error.code === 'rpc_timeout' || error.code === 'rpc_unavailable'
}

function redactedCode(error: unknown): string {
  return error instanceof ProductStoreError ? error.code : error instanceof Error ? error.name : 'unknown'
}

function isSyntheticInvalidIdentity(value: unknown): boolean {
  return typeof value === 'string' && value === value.trim() && !/[\s\x00-\x1F\x7F]/u.test(value) &&
    value.includes('@') && value.toLowerCase().endsWith('.invalid')
}

async function verifySyntheticFixtureArchive(dbPath: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const sources = db.prepare(`
      SELECT identifier
      FROM sources
      WHERE source_type='gmail'
      ORDER BY id ASC
      LIMIT 1001
    `).all() as Array<{ identifier: unknown }>
    if (sources.length > 1000) throw new ProductStoreError('corrupt_data', 'fixture archive has too many Gmail sources')
    for (const row of sources) {
      if (!isSyntheticInvalidIdentity(row.identifier)) {
        throw new ProductStoreError('corrupt_data', 'fixture Gmail source is not synthetic')
      }
    }
    const identities = db.prepare(`
      SELECT account_identities.address AS address
      FROM account_identities
      JOIN sources ON sources.id=account_identities.source_id
      WHERE sources.source_type='gmail'
      ORDER BY account_identities.source_id ASC, account_identities.address ASC
      LIMIT 1001
    `).all() as Array<{ address: unknown }>
    if (identities.length > 1000) throw new ProductStoreError('corrupt_data', 'fixture archive has too many Gmail identities')
    for (const row of identities) {
      if (!isSyntheticInvalidIdentity(row.address)) {
        throw new ProductStoreError('corrupt_data', 'fixture Gmail identity is not synthetic')
      }
    }
  } catch (error) {
    if (error instanceof ProductStoreError) throw error
    throw new ProductStoreError('corrupt_data', 'fixture archive schema is invalid')
  } finally {
    db.close()
  }
}

export class MailRuntimeLifecycleManager {
  readonly #options: MailRuntimeLifecycleOptions
  #logger?: MailRuntimeLogger
  #syncLease: MsgvaultSyncRuntimeLease | null = null
  #storeGeneration: MailStoreGeneration | null = null
  #nextGenerationId = 1
  #starting: Promise<void> | null = null
  #recovery: Promise<void> | null = null
  #shutdown = false
  #shutdownPromise: Promise<void> | null = null

  constructor(options: MailRuntimeLifecycleOptions = {}) {
    this.#options = options
    this.#logger = options.logger
  }

  setLogger(logger: MailRuntimeLogger): void {
    this.#logger = logger
  }

  get recoveryPending(): boolean { return this.#recovery !== null }
  get active(): boolean { return this.#storeGeneration !== null && !this.#shutdown }

  start(): Promise<void> {
    if (this.#shutdown) return Promise.reject(new Error('mail runtime is shutting down'))
    if (this.#storeGeneration || (this.#syncLease && this.#options.tolerateMissingMsgvault)) return Promise.resolve()
    if (this.#starting) return this.#starting
    this.#starting = this.#openInitial().finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async read<T>(operation: (store: MailStore) => Promise<T>): Promise<MailRuntimeReadResult<T>> {
    if (this.#shutdown || this.#recovery) return { status: 'unavailable' }
    await this.start().catch((error) => {
      this.#logger?.warn({ component: 'boring-mail-runtime', code: redactedCode(error) }, 'mail runtime startup unavailable')
    })
    const generation = this.#storeGeneration
    if (!generation || this.#shutdown || this.#recovery) return { status: 'unavailable' }
    try {
      const value = await operation(generation.store)
      if (this.#storeGeneration !== generation || this.#shutdown || this.#recovery) return { status: 'unavailable' }
      return { status: 'ok', value }
    } catch (error) {
      if (error instanceof ProductStoreError && error.code === 'stale_cursor') return { status: 'stale_cursor' }
      if (!isTypedUnavailable(error)) throw error
      if (requiresStoreRecovery(error)) this.#scheduleStoreRecovery(generation, error)
      this.#logger?.warn({ component: 'boring-mail-runtime', code: redactedCode(error) }, 'mail runtime read unavailable')
      return { status: 'unavailable' }
    }
  }

  #resolveMsgvault(sync: MsgvaultSyncRuntimeOptions | false | undefined): { dbPath: string; home?: string } {
    if (this.#options.msgvaultDbPath) {
      return { dbPath: resolve(this.#options.msgvaultDbPath), ...(this.#options.msgvaultHome ? { home: resolve(this.#options.msgvaultHome) } : {}) }
    }
    if (sync === false) return { dbPath: defaultMsgvaultDbPath(defaultMsgvaultHome()) }
    return resolveMsgvaultArchive({
      ...(this.#options.msgvaultHome ? { home: this.#options.msgvaultHome } : {}),
      ...((sync as MsgvaultSyncRuntimeOptions | undefined)?.home ? { home: (sync as MsgvaultSyncRuntimeOptions).home } : {}),
      ...((sync as MsgvaultSyncRuntimeOptions | undefined)?.dbPath ? { dbPath: (sync as MsgvaultSyncRuntimeOptions).dbPath } : {}),
    })
  }

  async #acquireSyncOnce(): Promise<void> {
    if (this.#syncLease) return
    const acquireSync = this.#options.acquireSync ?? acquireMsgvaultSyncRuntime
    this.#syncLease = await acquireSync(this.#options.sync, (message) => {
      this.#logger?.warn({ component: 'boring-mail-msgvault-sync' }, message)
    })
  }

  async #openStoreGeneration(): Promise<MailStoreGeneration | null> {
    const msgvault = this.#resolveMsgvault(this.#options.sync)
    if (this.#options.tolerateMissingMsgvault && !existsSync(msgvault.dbPath)) {
      this.#logger?.warn({ component: 'boring-mail-runtime', code: 'msgvault_unavailable' }, 'mail runtime fixture database unavailable')
      return null
    }
    if (this.#options.requireSyntheticFixture) {
      try {
        await verifySyntheticFixtureArchive(msgvault.dbPath)
      } catch (error) {
        if (this.#options.tolerateMissingMsgvault) {
          this.#logger?.warn({ component: 'boring-mail-runtime', code: redactedCode(error) }, 'mail runtime fixture database unavailable')
          return null
        }
        throw error
      }
    }
    const productDbPath = resolve(this.#options.productDbPath ?? defaultProductDbPath())
    await mkdir(dirname(productDbPath), { recursive: true, mode: 0o700 })
    await chmod(dirname(productDbPath), 0o700)
    const openStore = this.#options.openStore ?? defaultOpenMailStore
    let store: MailStore | null = null
    try {
      store = await openStore({ productDbPath, msgvaultDbPath: msgvault.dbPath }, {
        startupTimeoutMs: this.#options.startupTimeoutMs ?? MAIL_RUNTIME_STARTUP_TIMEOUT_MS,
        requestTimeoutMs: this.#options.requestTimeoutMs ?? MAIL_RUNTIME_READ_TIMEOUT_MS,
      })
      await store.reconcileMsgvaultReadSources()
      return { id: this.#nextGenerationId++, store }
    } catch (error) {
      await store?.close().catch(() => undefined)
      throw error
    }
  }

  async #openInitial(): Promise<void> {
    let acquiredSync = false
    try {
      if (!this.#syncLease) {
        await this.#acquireSyncOnce()
        acquiredSync = true
      }
      const generation = await this.#openStoreGeneration()
      if (this.#shutdown) {
        await generation?.store.close().catch(() => undefined)
        throw new Error('mail runtime is shutting down')
      }
      this.#storeGeneration = generation
    } catch (error) {
      if (acquiredSync) {
        await this.#syncLease?.release().catch(() => undefined)
        this.#syncLease = null
      }
      throw error
    }
  }

  #scheduleStoreRecovery(generation: MailStoreGeneration, cause: ProductStoreError): void {
    if (this.#shutdown || this.#recovery || this.#storeGeneration !== generation) return
    this.#storeGeneration = null
    this.#logger?.warn({ component: 'boring-mail-runtime', code: redactedCode(cause) }, 'mail runtime recovery scheduled')
    this.#recovery = (async () => {
      await generation.store.close().catch(() => undefined)
      if (this.#shutdown) return
      try {
        const replacement = await this.#openStoreGeneration()
        if (this.#shutdown) {
          await replacement?.store.close().catch(() => undefined)
          return
        }
        this.#storeGeneration = replacement
        this.#logger?.info?.({ component: 'boring-mail-runtime' }, 'mail runtime recovered')
      } catch (error) {
        this.#logger?.warn({ component: 'boring-mail-runtime', code: redactedCode(error) }, 'mail runtime recovery unavailable')
      }
    })().finally(() => {
      this.#recovery = null
    })
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise
    this.#shutdown = true
    this.#shutdownPromise = (async () => {
      await this.#starting?.catch(() => undefined)
      await this.#recovery?.catch(() => undefined)
      const generation = this.#storeGeneration
      const syncLease = this.#syncLease
      this.#storeGeneration = null
      this.#syncLease = null
      await generation?.store.close().catch((error) => {
        this.#logger?.warn({ component: 'boring-mail-runtime', code: redactedCode(error) }, 'mail runtime store shutdown failed')
      })
      await syncLease?.release().catch((error) => {
        this.#logger?.warn({ component: 'boring-mail-runtime', code: redactedCode(error) }, 'mail runtime sync shutdown failed')
      })
    })()
    return this.#shutdownPromise
  }
}
