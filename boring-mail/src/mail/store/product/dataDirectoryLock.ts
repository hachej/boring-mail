import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { ProductStoreError } from './types.js'

const LOCK_READY_TIMEOUT_MS = 5_000
const LOCK_FILENAME = '.boring-mail.lock'

export interface DataDirectoryLock {
  readonly path: string
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
    let settled = false
    let stderr = ''
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new ProductStoreError('rpc_timeout', 'timed out while acquiring the mail store data-directory lock'))
    }, LOCK_READY_TIMEOUT_MS)
    timeout.unref()

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      reject(error)
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      fail(new Error(`cannot execute flock for mail store lock: ${error.message}`))
    })
    child.stdout.setEncoding('utf8')
    let stdout = ''
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      stdout += chunk
      if (!stdout.includes('BORING_MAIL_LOCKED\n')) return
      settled = true
      clearTimeout(timeout)
      let released = false
      resolve({
        path,
        async release(): Promise<void> {
          if (released) return
          released = true
          child.stdin.end()
          const force = setTimeout(() => child.kill('SIGKILL'), LOCK_READY_TIMEOUT_MS)
          force.unref()
          await waitForExit(child)
          clearTimeout(force)
        },
      })
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`)
      if (code === 1) {
        fail(new ProductStoreError(
          'mail_store_already_active',
          `MAIL_STORE_ALREADY_ACTIVE: another process owns ${path}`,
        ))
      } else {
        fail(new Error(`mail store flock helper exited before acquiring the lock (${detail})`))
      }
    })
  })
}
