import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { discoverMsgvaultGmailAccounts } from './msgvaultAccounts.ts'
import { createMsgvaultSyncRunner } from './msgvaultSyncRunner.ts'
import {
  MsgvaultSyncSupervisor,
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

interface SingletonEntry {
  supervisor: MsgvaultSyncSupervisor
  refs: number
  ready: Promise<void>
  closing: Promise<void> | null
}

const REGISTRY_SYMBOL = Symbol.for('@hachej/boring-mail/msgvault-sync-supervisors.v1')
const root = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: Map<string, SingletonEntry> }
const registry = root[REGISTRY_SYMBOL] ??= new Map<string, SingletonEntry>()

function canonicalExisting(path: string, name: string): string {
  try { return realpathSync.native(resolve(path)) }
  catch { throw new Error(`REMEDIATION: ${name} does not exist; configure the msgvault runtime or disable sync`) }
}

export function defaultMsgvaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MSGVAULT_HOME?.trim() || join(homedir(), '.msgvault'))
}

export function defaultMsgvaultDbPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MSGVAULT_DB_PATH?.trim() || join(home, 'msgvault.db'))
}

/** Generic process singleton seam, exported for deterministic lifecycle tests. */
export async function acquireSyncSupervisorSingleton(
  key: string,
  create: () => MsgvaultSyncSupervisor,
): Promise<MsgvaultSyncRuntimeLease> {
  for (;;) {
    let entry = registry.get(key)
    if (entry?.closing) {
      await entry.closing
      continue
    }
    if (!entry) {
      const supervisor = create()
      entry = { supervisor, refs: 0, ready: supervisor.start(), closing: null }
      registry.set(key, entry)
    }
    try { await entry.ready }
    catch (error) {
      if (registry.get(key) === entry) registry.delete(key)
      throw error
    }
    // A last release may have begun while readiness was awaited.
    if (entry.closing) {
      await entry.closing
      continue
    }
    entry.refs++
    let released = false
    return {
      supervisor: entry.supervisor,
      async release() {
        if (released) return
        released = true
        entry!.refs--
        if (entry!.refs !== 0) return
        entry!.closing = entry!.supervisor.stop().finally(() => {
          if (registry.get(key) === entry) registry.delete(key)
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
  const homeInput = options?.home ?? defaultMsgvaultHome()
  const dbInput = options?.dbPath ?? defaultMsgvaultDbPath(homeInput)
  // Auto mode preserves the mock-only playground on machines without msgvault.
  if (options?.enabled !== true && !existsSync(dbInput)) return { supervisor: null, release: async () => undefined }
  const dbPath = canonicalExisting(dbInput, 'msgvault database')
  const home = existsSync(homeInput) ? canonicalExisting(homeInput, 'msgvault home') : dirname(dbPath)
  const configPath = options?.configPath ? canonicalExisting(options.configPath, 'msgvault config') : undefined
  const executable = options?.executable?.trim() || 'msgvault'
  const key = JSON.stringify({ dbPath, home, configPath: configPath ?? null, executable })
  return acquireSyncSupervisorSingleton(key, () => {
    const runner = createMsgvaultSyncRunner({ executable, home, ...(configPath ? { configPath } : {}) })
    return new MsgvaultSyncSupervisor({
      discoverAccounts: injected?.discoverAccounts ?? (() => discoverMsgvaultGmailAccounts({ dbPath })),
      syncAccount: injected?.syncAccount ?? runner,
      now: injected?.now ?? Date.now,
      random: injected?.random ?? Math.random,
      setTimeout: injected?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay)),
      clearTimeout: injected?.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    }, options ?? {})
  })
}
