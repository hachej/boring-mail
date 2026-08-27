#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { acquireMsgvaultArchiveLock } from '../src/mail/sync/msgvaultArchiveLock.ts'
import { createMsgvaultSyncRunner } from '../src/mail/sync/msgvaultSyncRunner.ts'

const executable = process.env.MSGVAULT_EXECUTABLE?.trim() || 'msgvault'
const version = spawnSync(executable, ['version'], { encoding: 'utf8' })
if (version.error?.code === 'ENOENT') {
  console.log('↷ msgvault direct-worker smoke skipped: executable unavailable')
  process.exit(0)
}
if (version.status !== 0 || !/msgvault v0\.19\./.test(`${version.stdout}\n${version.stderr}`)) {
  throw new Error('msgvault direct-worker smoke requires installed msgvault v0.19.x')
}

const root = mkdtempSync(join(tmpdir(), 'boring-mail-msgvault-direct-'))
const dbPath = join(root, 'msgvault.db')
let lock
try {
  // Bootstrap the schema through the same pinned direct-worker branch. The
  // missing source may make the command non-zero after schema creation.
  spawnSync(executable, ['--home', root, '--no-log-file', 'sync', '--', 'missing@example.invalid'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      MSGVAULT_DAEMON_CLI_PARENT_PID: String(process.pid),
    },
  })
  if (!existsSync(dbPath)) throw new Error('synthetic direct worker did not initialize the archive')

  lock = await acquireMsgvaultArchiveLock(dbPath)
  try {
    // A missing synthetic source may fail or be skipped depending on the pinned
    // patch release. Either way the direct worker must finish without creating
    // a background daemon.
    await createMsgvaultSyncRunner({ executable, archiveLock: lock })('missing@example.invalid').catch(() => undefined)
  } finally {
    await lock.release()
    lock = undefined
  }

  const paths = [root, dbPath, join(root, 'daemon.lock'), join(root, 'db.write.lock')]
  const statuses = paths.map((path) => spawnSync('/usr/bin/flock', [
    '-n', '-E', '73', path, '/bin/true',
  ]).status)
  if (statuses.some((status) => status !== 0)) {
    throw new Error('msgvault direct-worker smoke left an archive or daemon owner behind')
  }
  console.log('✓ msgvault v0.19 direct-worker smoke: no daemon survived and all ownership locks released')
} finally {
  await lock?.release().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}
