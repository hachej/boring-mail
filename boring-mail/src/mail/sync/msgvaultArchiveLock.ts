import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const LOCK_CONFLICT_EXIT = 73
const LOCK_START_TIMEOUT_MS = 10_000
const FLOCK_PATH = '/usr/bin/flock'
const CAT_PATH = '/bin/cat'
const CHILD_DIRECTORY_FD = 3
const CHILD_DATABASE_FD = 4
const CHILD_DAEMON_LOCK_FD = 5
const CHILD_WRITE_LOCK_FD = 6
const CHILD_CONFIG_FD = 7
const DAEMON_LOCK_FILE = 'daemon.lock'
const WRITE_LOCK_FILE = 'db.write.lock'
const MAX_CONFIG_BYTES = 1024 * 1024

export interface MsgvaultLockedSpawnContext {
  /** Descriptor-backed original home inside the spawned child. */
  readonly home: string
  /** Immutable config snapshot inside the spawned child. */
  readonly configPath: string
  /** Locked parent OFDs plus config snapshot copied into child fds 3–7. */
  readonly inheritedFds: readonly [
    directoryFd: number,
    databaseFd: number,
    daemonLockFd: number,
    writeLockFd: number,
    configFd: number,
  ]
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

function closeAll(fds: number[]): void {
  let first: unknown
  for (let index = fds.length - 1; index >= 0; index--) {
    if (fds[index]! < 0) continue
    try { closeSync(fds[index]!) }
    catch (error) { first ??= error }
    fds[index] = -1
  }
  if (first) throw first
}

/**
 * Own the archive and msgvault 0.19's daemon/write-owner locks on retained
 * open-file descriptions. Every direct sync child inherits those OFDs, so a
 * parent crash cannot unlock an orphaned writer. Owning daemon.lock also makes
 * ordinary msgvault daemon startup fail rather than overlap this supervisor.
 */
export async function acquireMsgvaultArchiveLock(
  dbPath: string,
  options: { configPath?: string } = {},
): Promise<MsgvaultArchiveLock> {
  const home = dirname(dbPath)
  const daemonLockPath = join(home, DAEMON_LOCK_FILE)
  const writeLockPath = join(home, WRITE_LOCK_FILE)
  const requestedConfigPath = options.configPath ?? join(home, 'config.toml')
  const configSourcePath = existsSync(requestedConfigPath) ? requestedConfigPath : null
  const fds = [-1, -1, -1, -1, -1]
  let child: ChildProcess | null = null
  let holderClosedCode: Promise<number> | null = null
  try {
    accessSync(FLOCK_PATH, fsConstants.X_OK)
    accessSync(CAT_PATH, fsConstants.X_OK)
    fds[0] = openSync(home, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    // O_NONBLOCK prevents a crafted FIFO/device path from freezing the event
    // loop before fstat can reject it.
    fds[1] = openSync(dbPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const lockOpenFlags = fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    fds[2] = openSync(daemonLockPath, lockOpenFlags, 0o600)
    fds[3] = openSync(writeLockPath, lockOpenFlags, 0o600)

    if (!fstatSync(fds[0]!).isDirectory()) throw genericLockError('msgvault home is not a directory')
    const labels = ['database', 'daemon lock', 'write-owner lock']
    for (let index = 1; index < 4; index++) {
      const stat = fstatSync(fds[index]!)
      if (!stat.isFile() || stat.nlink !== 1) {
        throw genericLockError(`msgvault ${labels[index - 1]} must be a single-link regular file`)
      }
    }

    child = spawn('/bin/sh', [
      '-c',
      `${FLOCK_PATH} -n -E ${LOCK_CONFLICT_EXIT} ${CHILD_DIRECTORY_FD} || exit $?; ` +
        `${FLOCK_PATH} -n -E ${LOCK_CONFLICT_EXIT} ${CHILD_DATABASE_FD} || exit $?; ` +
        `${FLOCK_PATH} -n -E ${LOCK_CONFLICT_EXIT} ${CHILD_DAEMON_LOCK_FD} || exit $?; ` +
        `${FLOCK_PATH} -n -E ${LOCK_CONFLICT_EXIT} ${CHILD_WRITE_LOCK_FD} || exit $?; ` +
        `printf 'ready\\n'; exec ${CAT_PATH} >/dev/null`,
    ], {
      stdio: ['pipe', 'pipe', 'ignore', fds[0], fds[1], fds[2], fds[3]],
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
          finish(new Error(
            'REMEDIATION: another msgvault or Boring Mail process owns this archive; stop its daemon or wait for its writer',
          ))
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

    // Snapshot exact config bytes only after all archive/native locks are held.
    // The anonymous 0600 inode cannot be renamed or changed by later config
    // edits, and every child reads only its inherited descriptor path.
    let configBytes = Buffer.alloc(0)
    if (configSourcePath) {
      const sourceFd = openSync(configSourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
      try {
        const source = fstatSync(sourceFd)
        if (!source.isFile() || source.nlink !== 1 || source.size > MAX_CONFIG_BYTES) {
          throw genericLockError('msgvault config must be a single-link regular file no larger than 1 MiB')
        }
        configBytes = readFileSync(sourceFd)
      } finally {
        closeSync(sourceFd)
      }
    }
    // Conservative fail-closed policy: msgvault 0.19 applies TOML after
    // --home, so any storage override could redirect the direct worker away
    // from the four owned archive/native lock OFDs.
    const normalizedConfig = configBytes.toString('utf8').replace(
      /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/gu,
      (_match, short: string | undefined, long: string | undefined) =>
        String.fromCodePoint(Number.parseInt(short ?? long!, 16)),
    )
    if (/(?:data_dir|database_url)/u.test(normalizedConfig)) {
      throw new Error(
        'REMEDIATION: msgvault config storage overrides are unsupported; remove data_dir/database_url and select the archive with MSGVAULT_HOME',
      )
    }
    const snapshotPath = join(home, `.boring-mail-msgvault-config-${randomBytes(16).toString('hex')}`)
    fds[4] = openSync(
      snapshotPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(fds[4]!, configBytes)
    } finally {
      unlinkSync(snapshotPath)
      configBytes.fill(0)
    }

    const identities = fds.slice(0, 4).map((fd) => fstatSync(fd, { bigint: true }))
    const namedPaths = [home, dbPath, daemonLockPath, writeLockPath]
    const assertNamedIdentity = () => {
      try {
        for (let index = 0; index < namedPaths.length; index++) {
          const named = statSync(namedPaths[index]!, { bigint: true })
          const held = identities[index]!
          if (named.dev !== held.dev || named.ino !== held.ino) throw new Error('identity mismatch')
        }
      } catch {
        throw new Error(
          'REMEDIATION: msgvault archive identity changed while sync ownership was active; restart after restoring the archive',
        )
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
        return `/proc/self/fd/${fds[1]}`
      },
      spawnContext() {
        if (released) throw new Error('REMEDIATION: msgvault archive ownership was released')
        assertNamedIdentity()
        return {
          home: `/proc/self/fd/${CHILD_DIRECTORY_FD}`,
          configPath: `/proc/self/fd/${CHILD_CONFIG_FD}`,
          inheritedFds: [fds[0]!, fds[1]!, fds[2]!, fds[3]!, fds[4]!],
        }
      },
      release() {
        if (releasePromise) return releasePromise
        released = true
        releasePromise = (async () => {
          holder.stdin?.end()
          await holderClosed
          closeAll(fds)
        })()
        return releasePromise
      },
    }
  } catch (error) {
    child?.stdin?.end()
    await holderClosedCode?.catch(() => undefined)
    try { closeAll(fds) } catch { /* preserve the actionable acquisition error */ }
    if (error instanceof Error && error.message.startsWith('REMEDIATION:')) throw error
    throw genericLockError('inspect archive type, permissions, existing daemon, and util-linux installation')
  }
}
