import { spawn } from 'node:child_process'
import type { MsgvaultArchiveLock } from './msgvaultArchiveLock.ts'

const MAX_CAPTURE_BYTES = 64 * 1024

// Pinned msgvault v0.19.3 normally routes `sync` through an auto-started
// daemon. Its own foreground daemon sets this marker to its immediate PID when
// spawning the verified direct worker (daemon_cli_subprocess.go / sync.go).
// Setting the same parent-bound marker keeps Boring Mail's child as the actual
// writer whose lifetime and inherited ownership OFDs we supervise.
const MSGVAULT_DIRECT_PARENT_ENV = 'MSGVAULT_DAEMON_CLI_PARENT_PID'

export interface MsgvaultSyncRunnerOptions {
  executable?: string
  home?: string
  configPath?: string
  spawnProcess?: typeof spawn
  archiveLock?: Pick<MsgvaultArchiveLock, 'spawnContext'>
  assertExecutableIdentity?: () => void
}

export type MsgvaultOutputClassification = 'changed' | 'empty' | 'unknown' | 'error'
export type MsgvaultSyncRunner = (account: string) => Promise<{ changed: boolean }>

/**
 * msgvault's daemon serializes all mutating operations before launching its
 * direct workers. Boring Mail uses that same direct-worker branch, so one FIFO
 * queue must reproduce the archive-wide single-writer invariant while the
 * supervisor remains free to schedule different account triggers concurrently.
 */
export function serializeMsgvaultSyncRunner(runner: MsgvaultSyncRunner): MsgvaultSyncRunner {
  let tail: Promise<void> = Promise.resolve()
  return (account) => {
    const result = tail.then(() => runner(account))
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Classify msgvault's final human summary centrally; unknown output stays active. */
export function classifyMsgvaultSyncOutput(output: string): MsgvaultOutputClassification {
  const errors = [...output.matchAll(/\bErrors:\s*(\d+)\b/gi)].map((match) => Number(match[1]))
  if (errors.some((count) => count > 0)) return 'error'
  const summaries = [...output.matchAll(/\bChanges:\s*(\d+)\s+processed,\s*(\d+)\s+added\b/gi)]
  const summary = summaries.at(-1)
  if (summary) return Number(summary[1]) > 0 || Number(summary[2]) > 0 ? 'changed' : 'empty'
  const counters = [...output.matchAll(
    /\b(?:new|added|created|imported|updated|changed|deleted|removed|synced)\s*(?:messages?)?\s*[:=]?\s*(\d+)\b/gi,
  )].map((match) => Number(match[1]))
  if (counters.some((count) => count > 0)) return 'changed'
  if (counters.length > 0) return 'empty'
  if (/\b(?:no changes|nothing to sync|up[ -]to[ -]date)\b/i.test(output)) return 'empty'
  return 'unknown'
}

/** Keep the final bytes, where msgvault 0.19 emits Changes/Errors summaries. */
function appendBoundedTail(current: Buffer, chunk: unknown): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
  if (incoming.length >= MAX_CAPTURE_BYTES) return incoming.subarray(incoming.length - MAX_CAPTURE_BYTES)
  if (current.length + incoming.length <= MAX_CAPTURE_BYTES) return Buffer.concat([current, incoming])
  const keep = MAX_CAPTURE_BYTES - incoming.length
  return Buffer.concat([current.subarray(current.length - keep), incoming])
}

/** Direct argv-only msgvault runner. Child output is never included in errors. */
export function createMsgvaultSyncRunner(options: MsgvaultSyncRunnerOptions = {}) {
  const executable = options.executable?.trim() || 'msgvault'
  const spawnProcess = options.spawnProcess ?? spawn
  return async (account: string): Promise<{ changed: boolean }> => {
    options.assertExecutableIdentity?.()
    const locked = options.archiveLock?.spawnContext()
    const executableForSpawn = locked?.executablePath ?? executable
    const home = locked?.home ?? options.home
    const configPath = locked?.configPath ?? options.configPath
    const args = [
      ...(home ? ['--home', home] : []),
      ...(configPath ? ['--config', configPath] : []),
      '--no-log-file',
      'sync',
      '--',
      account,
    ]
    let output: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const child = spawnProcess(executableForSpawn, args, {
        shell: false,
        env: {
          ...process.env,
          [MSGVAULT_DIRECT_PARENT_ENV]: String(process.pid),
        },
        stdio: locked
          ? ['ignore', 'pipe', 'pipe', ...locked.inheritedFds]
          : ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout?.on('data', (chunk) => { output = appendBoundedTail(output, chunk) })
      child.stderr?.on('data', (chunk) => { output = appendBoundedTail(output, chunk) })
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        if (error.code === 'ENOENT') {
          reject(new Error('REMEDIATION: msgvault executable was not found; install msgvault or configure its executable path'))
        } else {
          reject(new Error('msgvault sync process could not start'))
        }
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        if (code === 0) resolve()
        else reject(new Error(
          `REMEDIATION: msgvault sync failed (${signal ? 'terminated' : `exit ${code ?? 'unknown'}`}); inspect msgvault logs`,
        ))
      })
    })
    const classification = classifyMsgvaultSyncOutput(output.toString('utf8'))
    if (classification === 'error') {
      throw new Error('REMEDIATION: msgvault sync completed with item errors; inspect msgvault logs')
    }
    return { changed: classification !== 'empty' }
  }
}
