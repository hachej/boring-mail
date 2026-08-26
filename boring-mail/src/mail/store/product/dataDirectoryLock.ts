import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { ProductStoreError } from './types.js'

const LOCK_READY_TIMEOUT_MS = 5_000
const LOCK_FILENAME = '.boring-mail.lock'

export interface DataDirectoryLock {
  readonly path: string
  /** Internal helper PID is exposed for lock-loss health checks/tests only. */
  readonly helperPid: number
  /** Resolves only when kernel-backed ownership is lost unexpectedly. */
  readonly lost: Promise<Error>
  release(): Promise<void>
}

function ownerMetadata(): string {
  return JSON.stringify({
    pid: process.pid,
    processStartedAt: new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString(),
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

/**
 * Hold a kernel flock in a tiny child process for the worker lifetime.
 * The lock file is informational; ownership and crash release are enforced by
 * flock, so stale files and PID reuse cannot create stale-lock races.
 */
export function acquireDataDirectoryLock(directory: string): Promise<DataDirectoryLock> {
  const path = join(directory, LOCK_FILENAME)
  return new Promise((resolve, reject) => {
    const script = [
      `printf '%s\n' "$BORING_MAIL_LOCK_OWNER" > "$BORING_MAIL_LOCK_PATH"`,
      `printf 'BORING_MAIL_LOCKED\n'`,
      'cat >/dev/null',
    ].join('; ')
    const child = spawn('flock', ['-n', path, 'sh', '-c', script], {
      env: {
        ...process.env,
        BORING_MAIL_LOCK_OWNER: ownerMetadata(),
        BORING_MAIL_LOCK_PATH: path,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let acquired = false
    let intentionallyReleased = false
    let stderr = ''
    let resolveLost!: (error: Error) => void
    const lost = new Promise<Error>((resolveLoss) => { resolveLost = resolveLoss })
    const timeout = setTimeout(() => {
      if (acquired) return
      intentionallyReleased = true
      child.kill('SIGKILL')
      reject(new ProductStoreError('rpc_timeout', 'timed out while acquiring the mail store data-directory lock'))
    }, LOCK_READY_TIMEOUT_MS)
    timeout.unref()

    const failBeforeAcquire = (error: Error): void => {
      if (acquired || intentionallyReleased) return
      intentionallyReleased = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      reject(error)
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      failBeforeAcquire(new Error(`cannot execute flock for mail store lock: ${error.message}`))
    })
    child.stdout.setEncoding('utf8')
    let stdout = ''
    child.stdout.on('data', (chunk: string) => {
      if (acquired || intentionallyReleased) return
      stdout += chunk
      if (!stdout.includes('BORING_MAIL_LOCKED\n')) return
      acquired = true
      clearTimeout(timeout)
      resolve({
        path,
        helperPid: child.pid!,
        lost,
        async release(): Promise<void> {
          if (intentionallyReleased) return
          intentionallyReleased = true
          child.stdin.end()
          const force = setTimeout(() => child.kill('SIGKILL'), LOCK_READY_TIMEOUT_MS)
          force.unref()
          await waitForExit(child)
          clearTimeout(force)
        },
      })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (acquired) {
        if (!intentionallyReleased) {
          const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`)
          resolveLost(new ProductStoreError('mail_store_lock_lost', `mail store data-directory lock was lost (${detail})`))
        }
        return
      }
      if (intentionallyReleased) return
      const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`)
      if (code === 1) {
        failBeforeAcquire(new ProductStoreError(
          'mail_store_already_active',
          `MAIL_STORE_ALREADY_ACTIVE: another process owns ${path}`,
        ))
      } else {
        failBeforeAcquire(new Error(`mail store flock helper exited before acquiring the lock (${detail})`))
      }
    })
  })
}
