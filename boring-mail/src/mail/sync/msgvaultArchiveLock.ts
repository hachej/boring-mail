import { spawn, type ChildProcess } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'

const LOCK_CONFLICT_EXIT = 73
const LOCK_START_TIMEOUT_MS = 10_000
const FLOCK_PATH = '/usr/bin/flock'
const CAT_PATH = '/bin/cat'
const CHILD_DIRECTORY_FD = 3
const CHILD_DATABASE_FD = 4

export interface MsgvaultLockedSpawnContext {
  /** Descriptor-backed original home inside the spawned child. */
  readonly home: string
  /** Parent descriptors copied into child fd 3 and 4. */
  readonly inheritedFds: readonly [directoryFd: number, databaseFd: number]
}

export interface MsgvaultArchiveLock {
  /** Descriptor path for read-only discovery in this Node process. */
  databasePath(): string
  /** Validate named identities and return descriptors inherited by a sync child. */
  spawnContext(): MsgvaultLockedSpawnContext
  /** Diagnostics/test seam; lock ownership remains on retained OFDs if this exits. */
  readonly holderPid: number
  readonly holderClosed: Promise<void>
  release(): Promise<void>
}

function genericLockError(detail: string): Error {
  return new Error(`REMEDIATION: cannot safely lock the msgvault archive; ${detail}`)
}

/**
 * Acquire locks on open-file descriptions retained by the Node owner and copied
 * into every sync child. A parent crash therefore cannot unlock an orphaned
 * msgvault process: that child keeps the same locked OFDs until it exits.
 */
export async function acquireMsgvaultArchiveLock(dbPath: string): Promise<MsgvaultArchiveLock> {
  let directoryFd = -1
  let databaseFd = -1
  let child: ChildProcess | null = null
  let holderClosedCode: Promise<number> | null = null
  try {
    accessSync(FLOCK_PATH, fsConstants.X_OK)
    accessSync(CAT_PATH, fsConstants.X_OK)
    directoryFd = openSync(dirname(dbPath), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    // O_NONBLOCK prevents a crafted FIFO/device path from freezing the event loop
    // before fstat can reject it.
    databaseFd = openSync(dbPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    if (!fstatSync(directoryFd).isDirectory()) throw genericLockError('msgvault home is not a directory')
    const database = fstatSync(databaseFd)
    if (!database.isFile() || database.nlink !== 1) {
      throw genericLockError('msgvault database must be a single-link regular file')
    }
    child = spawn('/bin/sh', [
      '-c',
      `${FLOCK_PATH} -n -E ${LOCK_CONFLICT_EXIT} ${CHILD_DIRECTORY_FD} || exit $?; ` +
        `${FLOCK_PATH} -n -E ${LOCK_CONFLICT_EXIT} ${CHILD_DATABASE_FD} || exit $?; ` +
        `printf 'ready\\n'; exec ${CAT_PATH} >/dev/null`,
    ], {
      stdio: ['pipe', 'pipe', 'ignore', directoryFd, databaseFd],
    })

    const holder = child
    holderClosedCode = new Promise<number>((resolve) => {
      holder.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    await new Promise<void>((resolveReady, rejectReady) => {
      let output = ''
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) rejectReady(error)
        else resolveReady()
      }
      const timeout = setTimeout(() => {
        holder.kill('SIGKILL')
        finish(new Error('REMEDIATION: timed out acquiring the msgvault archive lock'))
      }, LOCK_START_TIMEOUT_MS)
      timeout.unref()
      holder.once('error', () => finish(new Error('REMEDIATION: cannot start util-linux flock for msgvault ownership')))
      holder.once('exit', (code, signal) => {
        if (code === LOCK_CONFLICT_EXIT) {
          finish(new Error('REMEDIATION: another Boring Mail process already owns this msgvault archive'))
        } else if (code !== 0 || signal) {
          finish(new Error('REMEDIATION: msgvault archive lock holder exited before startup'))
        }
      })
      holder.stdout?.setEncoding('utf8')
      holder.stdout?.on('data', (chunk: string) => {
        output = (output + chunk).slice(-32)
        if (output.includes('ready\n')) finish()
      })
    })
    const directoryIdentity = fstatSync(directoryFd, { bigint: true })
    const databaseIdentity = fstatSync(databaseFd, { bigint: true })
    const assertNamedIdentity = () => {
      try {
        const namedDirectory = statSync(dirname(dbPath), { bigint: true })
        const namedDatabase = statSync(dbPath, { bigint: true })
        if (namedDirectory.dev !== directoryIdentity.dev || namedDirectory.ino !== directoryIdentity.ino ||
            namedDatabase.dev !== databaseIdentity.dev || namedDatabase.ino !== databaseIdentity.ino) {
          throw new Error('identity mismatch')
        }
      } catch {
        throw new Error('REMEDIATION: msgvault archive identity changed while sync ownership was active; restart after restoring the archive')
      }
    }

    let released = false
    let releasePromise: Promise<void> | null = null
    const holderClosed = holderClosedCode.then(() => undefined)
    holder.stdin?.on('error', () => undefined)
    return {
      holderPid: holder.pid ?? -1,
      holderClosed,
      databasePath() {
        if (released) throw new Error('REMEDIATION: msgvault archive ownership was released')
        assertNamedIdentity()
        return `/proc/self/fd/${databaseFd}`
      },
      spawnContext() {
        if (released) throw new Error('REMEDIATION: msgvault archive ownership was released')
        assertNamedIdentity()
        return {
          home: `/proc/self/fd/${CHILD_DIRECTORY_FD}`,
          inheritedFds: [directoryFd, databaseFd],
        }
      },
      release() {
        if (releasePromise) return releasePromise
        released = true
        releasePromise = (async () => {
          holder.stdin?.end()
          await holderClosed
          closeSync(databaseFd)
          databaseFd = -1
          closeSync(directoryFd)
          directoryFd = -1
        })()
        return releasePromise
      },
    }
  } catch (error) {
    child?.stdin?.end()
    await holderClosedCode?.catch(() => undefined)
    if (databaseFd >= 0) closeSync(databaseFd)
    if (directoryFd >= 0) closeSync(directoryFd)
    if (error instanceof Error && error.message.startsWith('REMEDIATION:')) throw error
    throw genericLockError('inspect archive type, permissions, and util-linux installation')
  }
}
