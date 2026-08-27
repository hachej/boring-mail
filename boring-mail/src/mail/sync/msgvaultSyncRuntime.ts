import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { discoverMsgvaultGmailAccounts } from './msgvaultAccounts.ts'
import { acquireMsgvaultArchiveLock, type MsgvaultArchiveLock } from './msgvaultArchiveLock.ts'
import { createMsgvaultSyncRunner } from './msgvaultSyncRunner.ts'
import {
  ACTIVE_SYNC_INTERVAL_MS,
  ACTIVE_SYNC_JITTER_FRACTION,
  IDLE_AFTER_EMPTY_RUNS,
  IDLE_SYNC_MAX_MS,
  IDLE_SYNC_MIN_MS,
  MsgvaultSyncSupervisor,
  SUSPEND_HEARTBEAT_MS,
  SUSPEND_LATE_AFTER_MS,
  type MsgvaultSyncSupervisorDependencies,
  type MsgvaultSyncSupervisorOptions,
} from './msgvaultSyncSupervisor.ts'

export interface MsgvaultSyncRuntimeOptions extends MsgvaultSyncSupervisorOptions {
  enabled?: boolean
  dbPath?: string
  home?: string
  configPath?: string
  executable?: string
}

export interface MsgvaultSyncRuntimeLease {
  readonly supervisor: MsgvaultSyncSupervisor | null
  release(): Promise<void>
}

type ErrorSubscriber = (message: string) => void

interface SingletonEntry {
  supervisor: MsgvaultSyncSupervisor
  fingerprint: string
  refs: number
  ready: Promise<void>
  ownership: MsgvaultArchiveLock | null
  closing: Promise<void> | null
  subscribers: Set<ErrorSubscriber>
}

interface SingletonOptions {
  fingerprint?: string
  acquireOwnership?: () => Promise<MsgvaultArchiveLock>
  onError?: ErrorSubscriber
}

const REGISTRY_SYMBOL = Symbol.for('@hachej/boring-mail/msgvault-sync-supervisors.v3')
const root = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: Map<string, SingletonEntry> }
const registry = root[REGISTRY_SYMBOL] ??= new Map<string, SingletonEntry>()
const functionIds = new WeakMap<object, number>()
let nextFunctionId = 1

function canonicalExisting(path: string, name: string): string {
  try { return realpathSync.native(resolve(path)) }
  catch { throw new Error(`REMEDIATION: ${name} does not exist; configure the msgvault runtime or disable sync`) }
}

function functionId(value: object | undefined): number | null {
  if (!value) return null
  let id = functionIds.get(value)
  if (!id) { id = nextFunctionId++; functionIds.set(value, id) }
  return id
}

export function defaultMsgvaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MSGVAULT_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.msgvault'))
}

export function defaultMsgvaultDbPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MSGVAULT_DB_PATH?.trim() || join(home, 'msgvault.db'))
}

export interface ResolvedMsgvaultArchive {
  home: string
  dbPath: string
}

/** Resolve the one CLI-supported archive layout: <home>/msgvault.db. */
export function resolveMsgvaultArchive(
  options: Pick<MsgvaultSyncRuntimeOptions, 'home' | 'dbPath'> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMsgvaultArchive {
  const explicitHome = options.home?.trim() || env.MSGVAULT_HOME?.trim() || undefined
  const explicitDb = options.dbPath?.trim() || env.MSGVAULT_DB_PATH?.trim() || undefined
  if (explicitDb && basename(resolve(explicitDb)) !== 'msgvault.db') {
    throw new Error('REMEDIATION: MSGVAULT_DB_PATH must use the msgvault layout <home>/msgvault.db')
  }
  const dbPath = canonicalExisting(explicitDb ?? join(explicitHome ?? defaultMsgvaultHome(env), 'msgvault.db'), 'msgvault database')
  const derivedHome = canonicalExisting(dirname(dbPath), 'msgvault home')
  const home = explicitHome ? canonicalExisting(explicitHome, 'msgvault home') : derivedHome
  const expectedDb = canonicalExisting(join(home, 'msgvault.db'), 'msgvault database')
  if (expectedDb !== dbPath || home !== derivedHome) {
    throw new Error('REMEDIATION: msgvault home and database conflict; the CLI requires <home>/msgvault.db')
  }
  return { home, dbPath }
}

function resolveExecutable(input: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const executable = input?.trim() || 'msgvault'
  const candidates = isAbsolute(executable) || executable.includes('/')
    ? [resolve(executable)]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => resolve(directory, executable))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return realpathSync.native(candidate)
    } catch { /* keep searching */ }
  }
  throw new Error('REMEDIATION: msgvault executable was not found; install msgvault or configure its executable path')
}

function archiveIdentity(home: string, dbPath: string): string {
  try {
    const directory = statSync(home, { bigint: true })
    const database = statSync(dbPath, { bigint: true })
    return `${directory.dev}:${directory.ino}:${database.dev}:${database.ino}`
  } catch {
    throw new Error('REMEDIATION: msgvault archive identity changed during startup; retry after restoring the archive')
  }
}

/** Generic process singleton seam, exported for deterministic lifecycle tests. */
export async function acquireSyncSupervisorSingleton(
  key: string,
  create: (reportError: ErrorSubscriber) => MsgvaultSyncSupervisor,
  options: SingletonOptions = {},
): Promise<MsgvaultSyncRuntimeLease> {
  const fingerprint = options.fingerprint ?? 'default'
  // One wrapper per lease lets identical callbacks be independently removed.
  const subscriber = options.onError ? ((message: string) => options.onError!(message)) : null
  for (;;) {
    let entry = registry.get(key)
    if (entry?.closing) {
      await entry.closing
      continue
    }
    if (entry && entry.fingerprint !== fingerprint) {
      throw new Error('REMEDIATION: conflicting sync supervisor configuration for the same msgvault archive')
    }
    if (!entry) {
      const subscribers = new Set<ErrorSubscriber>()
      if (subscriber) subscribers.add(subscriber)
      const reportError = (message: string) => {
        for (const notify of [...subscribers]) {
          try { notify(message) } catch { /* diagnostics cannot break sync */ }
        }
      }
      const supervisor = create(reportError)
      entry = {
        supervisor,
        fingerprint,
        refs: 0,
        ownership: null,
        closing: null,
        subscribers,
        ready: Promise.resolve(),
      }
      const candidate = entry
      candidate.ready = (async () => {
        try {
          candidate.ownership = options.acquireOwnership ? await options.acquireOwnership() : null
          await candidate.supervisor.start()
        } catch (error) {
          // Release ownership only after stop proves startup/account work drained.
          await candidate.supervisor.stop()
          await candidate.ownership?.release()
          candidate.ownership = null
          throw error
        }
      })()
      registry.set(key, candidate)
    } else if (subscriber) {
      entry.subscribers.add(subscriber)
    }
    try { await entry.ready }
    catch (error) {
      if (subscriber) entry.subscribers.delete(subscriber)
      // A retained ownership object means cleanup failed: preserve the rejected
      // entry and kernel locks so no replacement can overlap it.
      if (registry.get(key) === entry && entry.ownership === null) registry.delete(key)
      throw error
    }
    if (entry.closing) {
      if (subscriber) entry.subscribers.delete(subscriber)
      await entry.closing
      continue
    }
    if (entry.fingerprint !== fingerprint) {
      if (subscriber) entry.subscribers.delete(subscriber)
      throw new Error('REMEDIATION: conflicting sync supervisor configuration for the same msgvault archive')
    }
    entry.refs++
    let released = false
    return {
      supervisor: entry.supervisor,
      async release() {
        if (released) return
        released = true
        if (subscriber) entry!.subscribers.delete(subscriber)
        entry!.refs--
        if (entry!.refs !== 0) return
        entry!.closing = (async () => {
          // Never release the ownership descriptors if stop fails before drain.
          await entry!.supervisor.stop()
          await entry!.ownership?.release()
          entry!.ownership = null
        })()
        entry!.closing.then(() => {
          if (registry.get(key) === entry) registry.delete(key)
        }, () => {
          // Fail closed: retain the rejected closing entry and ownership.
        })
        await entry!.closing
      },
    }
  }
}

export async function acquireMsgvaultSyncRuntime(
  options: MsgvaultSyncRuntimeOptions | false | undefined,
  injected?: Partial<MsgvaultSyncSupervisorDependencies>,
): Promise<MsgvaultSyncRuntimeLease> {
  if (options === false || options?.enabled === false) return { supervisor: null, release: async () => undefined }
  const homeHint = options?.home?.trim() || defaultMsgvaultHome()
  const dbHint = options?.dbPath?.trim() || defaultMsgvaultDbPath(homeHint)
  if (options?.enabled !== true && !existsSync(dbHint)) return { supervisor: null, release: async () => undefined }
  const { home, dbPath } = resolveMsgvaultArchive(options ?? {})
  const configPath = options?.configPath?.trim() ? canonicalExisting(options.configPath, 'msgvault config') : undefined
  const executable = resolveExecutable(options?.executable)
  const key = archiveIdentity(home, dbPath)
  const injectedFingerprint = injected && (
    injected.discoverAccounts || injected.syncAccount || injected.now || injected.random ||
    injected.setTimeout || injected.clearTimeout
  ) ? {
    discoverAccounts: functionId(injected.discoverAccounts),
    syncAccount: functionId(injected.syncAccount),
    now: functionId(injected.now),
    random: functionId(injected.random),
    setTimeout: functionId(injected.setTimeout),
    clearTimeout: functionId(injected.clearTimeout),
  } : null
  const fingerprint = JSON.stringify({
    executable,
    configPath: configPath ?? null,
    activeIntervalMs: options?.activeIntervalMs ?? ACTIVE_SYNC_INTERVAL_MS,
    activeJitterFraction: options?.activeJitterFraction ?? ACTIVE_SYNC_JITTER_FRACTION,
    idleMinMs: options?.idleMinMs ?? IDLE_SYNC_MIN_MS,
    idleMaxMs: options?.idleMaxMs ?? IDLE_SYNC_MAX_MS,
    idleAfterEmptyRuns: options?.idleAfterEmptyRuns ?? IDLE_AFTER_EMPTY_RUNS,
    heartbeatMs: options?.heartbeatMs ?? SUSPEND_HEARTBEAT_MS,
    suspendLateAfterMs: options?.suspendLateAfterMs ?? SUSPEND_LATE_AFTER_MS,
    injected: injectedFingerprint,
  })
  let ownership: MsgvaultArchiveLock | null = null
  return acquireSyncSupervisorSingleton(key, (reportError) => {
    const runner = createMsgvaultSyncRunner({
      executable,
      home,
      ...(configPath ? { configPath } : {}),
      archiveLock: { spawnContext: () => {
        if (!ownership) throw new Error('REMEDIATION: msgvault archive ownership is unavailable')
        return ownership.spawnContext()
      } },
    })
    return new MsgvaultSyncSupervisor({
      discoverAccounts: injected?.discoverAccounts ?? (() => {
        if (!ownership) throw new Error('REMEDIATION: msgvault archive ownership is unavailable')
        return discoverMsgvaultGmailAccounts({ dbPath: ownership.databasePath() })
      }),
      syncAccount: injected?.syncAccount ?? runner,
      now: injected?.now ?? Date.now,
      random: injected?.random ?? Math.random,
      setTimeout: injected?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay)),
      clearTimeout: injected?.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      onError: reportError,
    }, options ?? {})
  }, {
    fingerprint,
    onError: injected?.onError,
    acquireOwnership: async () => {
      ownership = await acquireMsgvaultArchiveLock(dbPath)
      return ownership
    },
  })
}
