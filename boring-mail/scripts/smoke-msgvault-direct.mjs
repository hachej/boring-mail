#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { acquireMsgvaultArchiveLock } from '../src/mail/sync/msgvaultArchiveLock.ts'
import { verifyMsgvaultContract } from '../src/mail/sync/msgvaultContract.ts'

const requestedExecutable = process.env.MSGVAULT_EXECUTABLE?.trim() || 'msgvault'
const required = process.env.BORING_MAIL_REQUIRE_MSGVAULT === '1'
const candidate = requestedExecutable.includes('/')
  ? requestedExecutable
  : (process.env.PATH ?? '').split(':').map((directory) => join(directory, requestedExecutable))
      .find((path) => existsSync(path))
if (!candidate) {
  if (required) throw new Error('required msgvault smoke needs exact installed msgvault v0.19.3; executable was unavailable')
  console.log('↷ msgvault direct-worker smoke skipped: executable unavailable')
  process.exit(0)
}
let executable
try {
  executable = realpathSync(candidate)
} catch (error) {
  if (error?.code === 'ENOENT') {
    if (required) throw new Error('required msgvault smoke needs exact installed msgvault v0.19.3; executable was unavailable')
    console.log('↷ msgvault direct-worker smoke skipped: executable unavailable')
    process.exit(0)
  }
  throw error
}
const version = spawnSync(executable, ['version'], {
  encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024,
})
if (version.error) throw version.error
if (version.status !== 0 || version.signal ||
    !/(?:^|\n)msgvault v0\.19\.3(?:\r?\n|$)/.test(`${version.stdout}\n${version.stderr}`)) {
  throw new Error('msgvault direct-worker smoke requires exact installed msgvault v0.19.3')
}

function directEnv() {
  return { ...process.env, MSGVAULT_DAEMON_CLI_PARENT_PID: String(process.pid) }
}

function probe(path) {
  return spawnSync('/usr/bin/flock', ['-n', '-E', '73', path, '/bin/true']).status
}

async function holdExternalLock(path) {
  const child = spawn('/usr/bin/flock', [path, '/bin/cat'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const closed = new Promise((resolve) => child.once('close', resolve))
  const deadline = Date.now() + 5_000
  while (probe(path) !== 73) {
    if (Date.now() >= deadline) {
      child.stdin?.end(); await closed
      throw new Error('timed out acquiring synthetic target ownership lock')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { async release() { child.stdin?.end(); await closed } }
}

const root = mkdtempSync(join(tmpdir(), 'boring-mail-msgvault-direct-'))
const target = mkdtempSync(join(tmpdir(), 'boring-mail-msgvault-redirect-'))
const dbPath = join(root, 'msgvault.db')
let lock
let targetHolder
try {
  // Bootstrap through the direct branch. Pinned v0.19.3 initializes the DB,
  // then returns its exact no-accounts outcome (not an ownership/daemon error).
  const bootstrap = spawnSync(executable, [
    '--home', root, '--config', '/dev/null', '--no-log-file', 'sync',
  ], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, env: directEnv(),
  })
  if (bootstrap.status !== 1 || !/no accounts configured/.test(bootstrap.stderr) || !existsSync(dbPath)) {
    throw new Error('synthetic direct worker did not produce the pinned empty-archive outcome')
  }

  // Exercise the pinned database key together with an existing explicit [data]
  // section; TOML must remain valid in the exact installed binary.
  writeFileSync(join(root, 'config.toml'), '[data]\nloose_attachments = true\n', { mode: 0o600 })
  lock = await acquireMsgvaultArchiveLock(dbPath, { executablePath: executable })
  try {
    await verifyMsgvaultContract(lock)
    const context = lock.spawnContext()
    const positive = spawnSync(context.executablePath, [
      '--home', context.home,
      '--config', context.configPath,
      '--no-log-file',
      'sync', '--', 'missing@example.invalid',
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 128 * 1024,
      env: directEnv(),
      stdio: ['ignore', 'pipe', 'pipe', ...context.inheritedFds],
    })
    if (positive.status !== 1 || positive.signal ||
        !/no source found - run 'sync-full' first/.test(positive.stderr) ||
        /daemon|write-owner lock|archive is owned/.test(positive.stderr)) {
      throw new Error('locked msgvault direct worker did not produce the pinned missing-source outcome')
    }
  } finally {
    await lock.release()
    lock = undefined
  }

  const paths = [root, dbPath, join(root, 'daemon.lock'), join(root, 'db.write.lock')]
  if (paths.some((path) => probe(path) !== 0)) {
    throw new Error('msgvault direct-worker smoke left an archive or daemon owner behind')
  }

  // First attest the pinned binary's case-insensitive redirect semantics in
  // isolation. Then reset the target, hold its native writer lock, and prove
  // Boring Mail rejects those exact mixed-case config bytes before the
  // redirected database can be created.
  const redirectConfig = join(root, 'config.toml')
  writeFileSync(redirectConfig, `[data]\nDaTa_DiR = ${JSON.stringify(target)}\n`, { mode: 0o600 })
  const upstreamRedirect = spawnSync(executable, [
    '--home', root, '--config', redirectConfig, '--no-log-file', 'sync',
  ], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, env: directEnv(),
  })
  if (upstreamRedirect.status !== 1 || !existsSync(join(target, 'msgvault.db'))) {
    throw new Error('installed msgvault did not demonstrate case-insensitive config redirect semantics')
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { mode: 0o700 })
  const targetWriteLock = join(target, 'db.write.lock')
  targetHolder = await holdExternalLock(targetWriteLock)
  let redirected = false
  let unexpectedLock
  try {
    unexpectedLock = await acquireMsgvaultArchiveLock(dbPath, { executablePath: executable })
  } catch (error) {
    redirected = error instanceof Error && /storage overrides are unsupported/.test(error.message)
  } finally {
    await unexpectedLock?.release().catch(() => undefined)
  }
  if (!redirected || existsSync(join(target, 'msgvault.db')) || probe(targetWriteLock) !== 73) {
    throw new Error('redirecting msgvault config was not rejected before touching its target archive')
  }

  console.log('✓ exact msgvault v0.19.3 direct-worker smoke: locked direct outcome verified, no daemon survived, config redirect refused')
} finally {
  await lock?.release().catch(() => undefined)
  await targetHolder?.release().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
}
