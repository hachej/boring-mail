import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { discoverMsgvaultGmailAccounts } from '../store/msgvault/gmailAccounts.ts'
import { acquireMsgvaultArchiveLock, type MsgvaultArchiveLock } from './msgvaultArchiveLock.ts'
import { SUPPORTED_MSGVAULT_VERSION, verifyMsgvaultContract } from './msgvaultContract.ts'
import { createMsgvaultSyncRunner, serializeMsgvaultSyncRunner } from './msgvaultSyncRunner.ts'
import {
  ACTIVE_SYNC_INTERVAL_MS,
  ACTIVE_SYNC_JITTER_FRACTION,
  IDLE_AFTER_EMPTY_RUNS,
  IDLE_SYNC_MAX_MS,
  IDLE_SYNC_MIN_MS,
  MsgvaultSyncSupervisor,
  SUSPEND_HEARTBEAT_MS,
  SUSPEND_LATE_AFTER_MS,
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

interface MsgvaultRuntimeEntry {
  supervisor: MsgvaultSyncSupervisor | null
  fingerprint: string
  refs: number
  ready: Promise<void>
  ownership: MsgvaultArchiveLock | null
  closing: Promise<void> | null
  subscribers: Set<ErrorSubscriber>
}

const REGISTRY_SYMBOL = Symbol.for('@hachej/boring-mail/msgvault-sync-supervisors.v4')
const root = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: Map<string, MsgvaultRuntimeEntry> }
const registry = root[REGISTRY_SYMBOL] ??= new Map<string, MsgvaultRuntimeEntry>()

function canonicalExisting(path: string, name: string): string {
  try { return realpathSync.native(resolve(path)) }
  catch { throw new Error(`REMEDIATION: ${name} does not exist; configure the msgvault runtime or disable sync`) }
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

function executableIdentity(executable: string): string {
  try {
    const stat = statSync(executable, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error('unsafe executable')
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
  } catch {
    throw new Error('REMEDIATION: msgvault executable identity changed; restart after restoring exact v0.19.3')
  }
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

function reportTo(entry: MsgvaultRuntimeEntry, message: string): void {
  for (const notify of [...entry.subscribers]) {
    try { notify(message) } catch { /* diagnostics cannot break sync */ }
  }
}

function normalizedFingerprint(
  options: MsgvaultSyncRuntimeOptions,
  executable: string,
  executableId: string,
  configPath: string | null,
): string {
  return JSON.stringify({
    executable,
    executableId,
    version: SUPPORTED_MSGVAULT_VERSION,
    configPath,
    activeIntervalMs: options.activeIntervalMs ?? ACTIVE_SYNC_INTERVAL_MS,
    activeJitterFraction: options.activeJitterFraction ?? ACTIVE_SYNC_JITTER_FRACTION,
    idleMinMs: options.idleMinMs ?? IDLE_SYNC_MIN_MS,
    idleMaxMs: options.idleMaxMs ?? IDLE_SYNC_MAX_MS,
    idleAfterEmptyRuns: options.idleAfterEmptyRuns ?? IDLE_AFTER_EMPTY_RUNS,
    heartbeatMs: options.heartbeatMs ?? SUSPEND_HEARTBEAT_MS,
    suspendLateAfterMs: options.suspendLateAfterMs ?? SUSPEND_LATE_AFTER_MS,
  })
}

/** Acquire one msgvault-specific, lock-owning runtime entry for this process. */
export async function acquireMsgvaultSyncRuntime(
  options: MsgvaultSyncRuntimeOptions | false | undefined,
  onError?: ErrorSubscriber,
): Promise<MsgvaultSyncRuntimeLease> {
  if (options === false || options?.enabled === false) return { supervisor: null, release: async () => undefined }
  const normalized = options ?? {}
  const homeHint = normalized.home?.trim() || defaultMsgvaultHome()
  const dbHint = normalized.dbPath?.trim() || defaultMsgvaultDbPath(homeHint)
  if (normalized.enabled !== true && !existsSync(dbHint)) return { supervisor: null, release: async () => undefined }
  const { home, dbPath } = resolveMsgvaultArchive(normalized)
  const requestedConfig = normalized.configPath?.trim() || join(home, 'config.toml')
  const configPath = existsSync(requestedConfig)
    ? canonicalExisting(requestedConfig, 'msgvault config')
    : normalized.configPath?.trim()
      ? canonicalExisting(requestedConfig, 'msgvault config')
      : null
  const executable = resolveExecutable(normalized.executable)
  const executableId = executableIdentity(executable)
  const key = archiveIdentity(home, dbPath)
  const fingerprint = normalizedFingerprint(normalized, executable, executableId, configPath)
  // One wrapper per lease lets identical callbacks be independently removed.
  const subscriber = onError ? ((message: string) => onError(message)) : null

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
      const candidate: MsgvaultRuntimeEntry = {
        supervisor: null,
        fingerprint,
        refs: 0,
        ownership: null,
        closing: null,
        subscribers,
        ready: Promise.resolve(),
      }
      candidate.ready = (async () => {
        try {
          candidate.ownership = await acquireMsgvaultArchiveLock(dbPath, {
            ...(configPath ? { configPath } : {}),
            executablePath: executable,
          })
          const ownership = candidate.ownership
          if (ownership.executableIdentity() !== executableId) {
            throw new Error('REMEDIATION: msgvault executable changed during acquisition; retry with exact v0.19.3')
          }
          await verifyMsgvaultContract(ownership)
          const runner = serializeMsgvaultSyncRunner(createMsgvaultSyncRunner({
            executable,
            home,
            archiveLock: ownership,
          }))
          candidate.supervisor = new MsgvaultSyncSupervisor({
            discoverAccounts: () => discoverMsgvaultGmailAccounts({ dbPath: ownership.databasePath() }),
            syncAccount: runner,
            now: Date.now,
            random: Math.random,
            setTimeout: (callback, delay) => setTimeout(callback, delay),
            clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
            onError: (message) => reportTo(candidate, message),
          }, normalized)
          await candidate.supervisor.start()
        } catch (error) {
          // Fail closed unless startup/account work drains before lock release.
          await candidate.supervisor?.stop()
          await candidate.ownership?.release()
          candidate.ownership = null
          throw error
        }
      })()
      registry.set(key, candidate)
      entry = candidate
    } else if (subscriber) {
      entry.subscribers.add(subscriber)
    }

    try { await entry.ready }
    catch (error) {
      if (subscriber) entry.subscribers.delete(subscriber)
      if (registry.get(key) === entry && entry.ownership === null) registry.delete(key)
      throw error
    }
    if (entry.closing) {
      if (subscriber) entry.subscribers.delete(subscriber)
      await entry.closing
      continue
    }
    if (entry.fingerprint !== fingerprint || !entry.supervisor) {
      if (subscriber) entry.subscribers.delete(subscriber)
      throw new Error('REMEDIATION: conflicting or incomplete sync runtime for the same msgvault archive')
    }

    entry.refs++
    let released = false
    const supervisor = entry.supervisor
    return {
      supervisor,
      async release() {
        if (released) return
        released = true
        if (subscriber) entry!.subscribers.delete(subscriber)
        entry!.refs--
        if (entry!.refs !== 0) return
        entry!.closing = (async () => {
          // Never release ownership descriptors if shutdown fails before drain.
          await entry!.supervisor!.stop()
          await entry!.ownership!.release()
          entry!.ownership = null
        })()
        entry!.closing.then(() => {
          if (registry.get(key) === entry) registry.delete(key)
        }, () => {
          // Fail closed: retain the rejected entry and ownership.
        })
        await entry!.closing
      },
    }
  }
}
