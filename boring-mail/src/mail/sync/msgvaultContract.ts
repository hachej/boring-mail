import { spawn } from 'node:child_process'
import type { MsgvaultArchiveLock } from './msgvaultArchiveLock.ts'

export const SUPPORTED_MSGVAULT_VERSION = '0.19.3'
const VERSION_TIMEOUT_MS = 5_000
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024

function appendBounded(current: Buffer, chunk: unknown): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
  if (incoming.length >= MAX_VERSION_OUTPUT_BYTES) return incoming.subarray(0, MAX_VERSION_OUTPUT_BYTES)
  if (current.length + incoming.length <= MAX_VERSION_OUTPUT_BYTES) return Buffer.concat([current, incoming])
  return Buffer.concat([current, incoming.subarray(0, MAX_VERSION_OUTPUT_BYTES - current.length)])
}

/**
 * Verify the exact private direct-worker contract before scheduling. The probe
 * reads the same descriptor-backed immutable config and home as every sync;
 * output is bounded and never copied into errors.
 */
export async function verifyMsgvaultContract(
  archiveLock: Pick<MsgvaultArchiveLock, 'spawnContext'>,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const locked = archiveLock.spawnContext()
  let output: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timeoutError: Error | null = null
    const child = spawn(locked.executablePath, [
      '--home', locked.home,
      '--config', locked.configPath,
      '--no-log-file',
      'version',
    ], {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', ...locked.inheritedFds],
      windowsHide: true,
    })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => {
      timeoutError = new Error('REMEDIATION: msgvault version probe timed out; install exact msgvault v0.19.3')
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') }
      catch { child.kill('SIGKILL') }
      // Do not let an escaped descendant retaining a capture pipe make the
      // attestation promise unbounded. It also retains ownership OFDs, so any
      // malicious escape remains fail-closed against a replacement runtime.
      child.stdout?.destroy()
      child.stderr?.destroy()
      finish(timeoutError)
    }, options.timeoutMs ?? VERSION_TIMEOUT_MS)
    timeout.unref()
    child.stdout?.on('data', (chunk) => { output = appendBounded(output, chunk) })
    child.stderr?.on('data', (chunk) => { output = appendBounded(output, chunk) })
    child.once('error', () => finish(new Error('REMEDIATION: cannot execute msgvault version probe')))
    child.once('close', (code, signal) => {
      if (timeoutError) finish(timeoutError)
      else if (code === 0 && !signal) finish()
      else finish(new Error('REMEDIATION: msgvault version probe failed; install exact msgvault v0.19.3'))
    })
  })
  const text = output.toString('utf8')
  if (!new RegExp(`(?:^|\\n)msgvault v${SUPPORTED_MSGVAULT_VERSION.replaceAll('.', '\\.')}(?:\\r?\\n|$)`).test(text)) {
    throw new Error(`REMEDIATION: unsupported msgvault version; install exact msgvault v${SUPPORTED_MSGVAULT_VERSION}`)
  }
  return SUPPORTED_MSGVAULT_VERSION
}
