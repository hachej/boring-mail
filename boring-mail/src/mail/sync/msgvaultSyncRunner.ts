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

const ERROR_SUMMARY_TOKEN = Buffer.from('errors:', 'ascii')

type ErrorDetectorStage = 'search' | 'token' | 'space' | 'digits'

function isAsciiWord(byte: number): boolean {
  return byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte === 95 || byte >= 97 && byte <= 122
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 11 || byte === 12 || byte === 13 || byte === 32
}

function asciiLower(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte
}

/**
 * Incrementally recognize `Errors: N` with O(1) state. One detector belongs to
 * one child stream so independently emitted bytes can never synthesize a token.
 */
export class StickyMsgvaultItemErrorDetector {
  private stage: ErrorDetectorStage = 'search'
  private tokenIndex = 0
  private previousWasWord = false
  private candidateIsNonzero = false
  private sticky = false

  push(chunk: unknown): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    for (const byte of incoming) this.pushByte(byte)
  }

  finish(): boolean {
    if (this.stage === 'digits' && this.candidateIsNonzero) this.sticky = true
    return this.sticky
  }

  private startSearch(byte: number, previousWasWord: boolean): void {
    this.stage = 'search'
    this.tokenIndex = 0
    this.candidateIsNonzero = false
    if (!previousWasWord && asciiLower(byte) === ERROR_SUMMARY_TOKEN[0]) {
      this.stage = 'token'
      this.tokenIndex = 1
    }
  }

  private pushByte(byte: number): void {
    const previousWasWord = this.previousWasWord
    const currentIsWord = isAsciiWord(byte)

    if (this.stage === 'digits') {
      if (byte >= 48 && byte <= 57) {
        if (byte !== 48) this.candidateIsNonzero = true
      } else {
        if (!currentIsWord && this.candidateIsNonzero) this.sticky = true
        this.startSearch(byte, previousWasWord)
      }
      this.previousWasWord = currentIsWord
      return
    }

    if (this.stage === 'space') {
      if (isAsciiWhitespace(byte)) {
        this.previousWasWord = currentIsWord
        return
      }
      if (byte >= 48 && byte <= 57) {
        this.stage = 'digits'
        this.candidateIsNonzero = byte !== 48
      } else {
        this.startSearch(byte, previousWasWord)
      }
      this.previousWasWord = currentIsWord
      return
    }

    if (this.stage === 'token') {
      if (asciiLower(byte) === ERROR_SUMMARY_TOKEN[this.tokenIndex]) {
        this.tokenIndex++
        if (this.tokenIndex === ERROR_SUMMARY_TOKEN.length) this.stage = 'space'
      } else {
        this.startSearch(byte, previousWasWord)
      }
      this.previousWasWord = currentIsWord
      return
    }

    this.startSearch(byte, previousWasWord)
    this.previousWasWord = currentIsWord
  }
}

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

function classifyMsgvaultChanges(output: string): Exclude<MsgvaultOutputClassification, 'error'> {
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

/** Classify complete msgvault output; streaming runners additionally retain sticky errors. */
export function classifyMsgvaultSyncOutput(output: string): MsgvaultOutputClassification {
  const errors = [...output.matchAll(/\bErrors:\s*(\d+)\b/gi)].map((match) => Number(match[1]))
  if (errors.some((count) => count > 0)) return 'error'
  return classifyMsgvaultChanges(output)
}

/** Keep final bytes for change/empty classification; errors are detected while streaming. */
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
    const stdoutErrors = new StickyMsgvaultItemErrorDetector()
    const stderrErrors = new StickyMsgvaultItemErrorDetector()
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
      child.stdout?.on('data', (chunk) => {
        stdoutErrors.push(chunk)
        output = appendBoundedTail(output, chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderrErrors.push(chunk)
        output = appendBoundedTail(output, chunk)
      })
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
    const hasItemErrors = stdoutErrors.finish() || stderrErrors.finish()
    const classification = classifyMsgvaultChanges(output.toString('utf8'))
    if (hasItemErrors) {
      throw new Error('REMEDIATION: msgvault sync completed with item errors; inspect msgvault logs')
    }
    return { changed: classification !== 'empty' }
  }
}
