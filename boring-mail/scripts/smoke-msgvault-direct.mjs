#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { acquireMsgvaultArchiveLock } from '../src/mail/sync/msgvaultArchiveLock.ts'
import { verifyMsgvaultContract } from '../src/mail/sync/msgvaultContract.ts'

const executable = process.env.MSGVAULT_EXECUTABLE?.trim() || 'msgvault'
const version = spawnSync(executable, ['version'], { encoding: 'utf8' })
if (version.error?.code === 'ENOENT') {
  console.log('↷ msgvault direct-worker smoke skipped: executable unavailable')
  process.exit(0)
}
if (version.status !== 0 || !/(?:^|\n)msgvault v0\.19\.3(?:\r?\n|$)/.test(`${version.stdout}\n${version.stderr}`)) {
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

  lock = await acquireMsgvaultArchiveLock(dbPath)
  try {
    await verifyMsgvaultContract(executable, lock)
    const context = lock.spawnContext()
    const positive = spawnSync(executable, [
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

  // Real installed-binary redirect regression: hold the target's native writer
  // lock, then prove config validation refuses before a target DB is created.
  const targetWriteLock = join(target, 'db.write.lock')
  targetHolder = await holdExternalLock(targetWriteLock)
  writeFileSync(join(root, 'config.toml'), `[data]\ndata_dir = ${JSON.stringify(target)}\n`, { mode: 0o600 })
  let redirected = false
  let unexpectedLock
  try {
    unexpectedLock = await acquireMsgvaultArchiveLock(dbPath)
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
