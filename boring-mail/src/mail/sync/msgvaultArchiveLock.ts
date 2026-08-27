import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
} from 'node:fs'
import { dirname } from 'node:path'

const LOCK_CONFLICT_EXIT = 73
const LOCK_START_TIMEOUT_MS = 10_000

export interface MsgvaultArchiveLock {
  release(): Promise<void>
}

/**
 * Hold cooperative kernel locks for the canonical archive directory and DB
 * inode. The static shell only coordinates util-linux flock; no path or caller
 * value is interpolated into it.
 */
export async function acquireMsgvaultArchiveLock(dbPath: string): Promise<MsgvaultArchiveLock> {
  let directoryFd = -1
  let databaseFd = -1
  let child: ChildProcess
  try {
    directoryFd = openSync(dirname(dbPath), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    databaseFd = openSync(dbPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    if (!fstatSync(directoryFd).isDirectory()) throw new Error('msgvault home is not a directory')
    const database = fstatSync(databaseFd)
    if (!database.isFile() || database.nlink !== 1) throw new Error('msgvault database must be a single-link regular file')
    child = spawn('/bin/sh', [
      '-c',
      `flock -n -E ${LOCK_CONFLICT_EXIT} 3 || exit $?; flock -n -E ${LOCK_CONFLICT_EXIT} 4 || exit $?; printf 'ready\\n'; cat >/dev/null`,
    ], {
      stdio: ['pipe', 'pipe', 'ignore', directoryFd, databaseFd],
    })
  } catch (error) {
    throw new Error(`REMEDIATION: cannot safely lock the msgvault archive; ${error instanceof Error ? error.message : 'inspect archive permissions'}`)
  } finally {
    if (databaseFd >= 0) closeSync(databaseFd)
    if (directoryFd >= 0) closeSync(directoryFd)
  }

  const closed = new Promise<number>((resolve) => child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0))))
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new Error('REMEDIATION: timed out acquiring the msgvault archive lock'))
      }, LOCK_START_TIMEOUT_MS)
      timeout.unref()
      child.once('error', () => finish(new Error('REMEDIATION: cannot start util-linux flock for msgvault ownership')))
      child.once('exit', (code, signal) => {
        if (code === LOCK_CONFLICT_EXIT) {
          finish(new Error('REMEDIATION: another Boring Mail process already owns this msgvault archive'))
        } else if (code !== 0 || signal) {
          finish(new Error('REMEDIATION: msgvault archive lock holder exited before startup'))
        }
      })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        output = (output + chunk).slice(-32)
        if (output.includes('ready\n')) finish()
      })
    })
  } catch (error) {
    child.stdin?.end()
    await closed
    throw error
  }

  let releasePromise: Promise<void> | null = null
  return {
    release() {
      if (releasePromise) return releasePromise
      releasePromise = (async () => {
        child.stdin?.end()
        await closed
      })()
      return releasePromise
    },
  }
}
