// @vitest-environment node
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import createBoringMailServerPlugin from '../src/boring-ui/server.js'
import { acquireMsgvaultArchiveLock } from '../src/mail/sync/msgvaultArchiveLock.js'
import { verifyMsgvaultContract } from '../src/mail/sync/msgvaultContract.js'
import {
  acquireMsgvaultSyncRuntime,
  resolveMsgvaultArchive,
  type MsgvaultSyncRuntimeLease,
} from '../src/mail/sync/msgvaultSyncRuntime.js'

function createArchive(root: string, account = 'CaseSensitive@Example.Test'): string {
  const dbPath = join(root, 'msgvault.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE sources(id INTEGER PRIMARY KEY,source_type TEXT NOT NULL,identifier TEXT NOT NULL);
    INSERT INTO sources VALUES(1,'gmail','${account}')`)
  db.close()
  return dbPath
}

function createExecutable(root: string, body: string, version = '0.19.3'): string {
  const executable = join(root, 'fake-msgvault')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv.includes('version')) { const i=process.argv.indexOf('--home');console.error('data_dir='+process.argv[i+1]);console.log('msgvault v${version}'); process.exit(0) }
${body}
`)
  chmodSync(executable, 0o700)
  return executable
}

async function releaseAll(leases: MsgvaultSyncRuntimeLease[]): Promise<void> {
  for (const lease of leases.reverse()) await lease.release().catch(() => undefined)
}

describe('msgvault sync runtime', () => {
  it('keeps custom database discovery and descriptor-backed CLI home coherent', async () => {
    const defaultBase = mkdtempSync(join(tmpdir(), 'mv-default-'))
    const defaultRoot = join(defaultBase, '.msgvault')
    mkdirSync(defaultRoot)
    createArchive(defaultRoot, 'default@test')
    const customRoot = mkdtempSync(join(tmpdir(), 'mv-custom-'))
    const dbPath = createArchive(customRoot)
    expect(resolveMsgvaultArchive({}, { HOME: defaultBase, MSGVAULT_DB_PATH: dbPath }))
      .toEqual({ home: customRoot, dbPath })
    expect(() => resolveMsgvaultArchive({}, { MSGVAULT_HOME: defaultRoot, MSGVAULT_DB_PATH: dbPath }))
      .toThrow(/home and database conflict/)
    expect(() => resolveMsgvaultArchive({ dbPath: join(customRoot, 'archive.db') }, {})).toThrow(/<home>\/msgvault.db/)

    const argvPath = join(customRoot, 'argv.json')
    const executable = createExecutable(customRoot,
      `require('node:fs').writeFileSync(${JSON.stringify(argvPath)},JSON.stringify(process.argv.slice(2)));console.log('Changes: 0 processed, 0 added')`)
    const alias = join(customRoot, 'msgvault-alias')
    symlinkSync(executable, alias)
    const leases: MsgvaultSyncRuntimeLease[] = []
    const previousDb = process.env.MSGVAULT_DB_PATH
    const previousHome = process.env.MSGVAULT_HOME
    try {
      const first = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable })
      leases.push(first)
      const second = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable: alias })
      leases.push(second)
      process.env.MSGVAULT_DB_PATH = dbPath
      delete process.env.MSGVAULT_HOME
      const blank = await acquireMsgvaultSyncRuntime({ home: '   ', dbPath: '   ', executable })
      leases.push(blank)
      expect(second.supervisor).toBe(first.supervisor)
      expect(blank.supervisor).toBe(first.supervisor)
      expect(first.supervisor?.health().map((health) => health.account)).toEqual(['CaseSensitive@Example.Test'])
      await first.supervisor?.syncNow('CaseSensitive@Example.Test')
      expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual([
        '--home', '/proc/self/fd/3', '--config', '/proc/self/fd/7', '--no-log-file',
        'sync', '--', 'CaseSensitive@Example.Test',
      ])
      await expect(acquireMsgvaultSyncRuntime({
        enabled: true, dbPath, executable, activeIntervalMs: 121_000,
      })).rejects.toThrow(/conflicting sync supervisor configuration/)
      expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', customRoot, '/bin/true']).status).toBe(73)
      await blank.release(); leases.pop()
      await second.release(); leases.pop()
      expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', customRoot, '/bin/true']).status).toBe(73)
      await first.release(); leases.pop()
      expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', customRoot, '/bin/true']).status).toBe(0)
    } finally {
      if (previousDb === undefined) delete process.env.MSGVAULT_DB_PATH
      else process.env.MSGVAULT_DB_PATH = previousDb
      if (previousHome === undefined) delete process.env.MSGVAULT_HOME
      else process.env.MSGVAULT_HOME = previousHome
      await releaseAll(leases)
    }
  })

  it('pins exact config bytes and rejects storage redirection before spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-config-pin-'))
    const dbPath = createArchive(root, 'config@test')
    const configPath = join(root, 'config.toml')
    const observedPath = join(root, 'observed-config')
    writeFileSync(configPath, '# original config\n')
    const executable = createExecutable(root, `
const fs=require('node:fs');const args=process.argv.slice(2);const config=args[args.indexOf('--config')+1];
fs.writeFileSync(${JSON.stringify(observedPath)},fs.readFileSync(config));console.log('Changes: 0 processed, 0 added')`)
    const lease = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable, configPath })
    try {
      writeFileSync(configPath, '# changed after acquisition\n')
      await lease.supervisor?.syncNow('config@test')
      expect(readFileSync(observedPath, 'utf8')).toBe(
        'data.database_url = "/proc/self/fd/4"\n# original config\n',
      )
    } finally {
      await lease.release()
    }

    const target = mkdtempSync(join(tmpdir(), 'mv-config-target-'))
    writeFileSync(configPath, `[data]\ndata_dir = ${JSON.stringify(target)}\n`)
    await expect(acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable, configPath }))
      .rejects.toThrow(/storage overrides are unsupported/)
    expect(existsSync(join(target, 'msgvault.db'))).toBe(false)
  })

  it('executes the verified held executable after atomic pathname replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-executable-pin-'))
    const dbPath = createArchive(root, 'pin@test')
    const marker = join(root, 'executed')
    const executable = createExecutable(root,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)},'old\\n');console.log('Changes: 0 processed, 0 added')`)
    const lease = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable })
    try {
      const replacement = join(root, 'replacement-msgvault')
      writeFileSync(replacement, `#!/usr/bin/env node
if (process.argv.includes('version')) { console.log('msgvault v0.19.3'); process.exit(0) }
require('node:fs').appendFileSync(${JSON.stringify(marker)},'new\\n');console.log('Changes: 0 processed, 0 added')
`)
      chmodSync(replacement, 0o700)
      renameSync(executable, join(root, 'verified-msgvault'))
      renameSync(replacement, executable)
      writeFileSync(marker, '')
      await lease.supervisor?.syncNow('pin@test')
      expect(readFileSync(marker, 'utf8')).toBe('old\n')
    } finally {
      await lease.release()
    }
  })

  it('requires the exact pinned msgvault version before scheduling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-version-pin-'))
    const dbPath = createArchive(root, 'version@test')
    const executable = createExecutable(root, `console.log('Changes: 0 processed, 0 added')`, '0.19.4')
    await expect(acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable }))
      .rejects.toThrow(/install exact msgvault v0\.19\.3/)
    expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', root, '/bin/true']).status).toBe(0)
  })

  it('bounds a hung exact-version contract probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-version-timeout-'))
    const dbPath = createArchive(root, 'timeout@test')
    const executable = join(root, 'hanging-msgvault')
    writeFileSync(executable, '#!/bin/sh\nexec sleep 10\n'); chmodSync(executable, 0o700)
    const lock = await acquireMsgvaultArchiveLock(dbPath, { executablePath: executable })
    try {
      await expect(verifyMsgvaultContract(lock, { timeoutMs: 20 }))
        .rejects.toThrow(/version probe timed out/)
    } finally {
      await lock.release()
    }
  })

  it('settles a version timeout even when a setsid descendant escapes capture pipes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-version-escape-'))
    const dbPath = createArchive(root, 'escape@test')
    const executable = join(root, 'escaping-msgvault')
    const pidPath = join(root, 'escaped.pid')
    writeFileSync(executable, `#!/bin/sh
setsid sh -c 'echo $$ > "${pidPath}"; sleep 10' &
exec sleep 10
`)
    chmodSync(executable, 0o700)
    const lock = await acquireMsgvaultArchiveLock(dbPath, { executablePath: executable })
    const started = Date.now()
    try {
      await expect(verifyMsgvaultContract(lock, { timeoutMs: 20 })).rejects.toThrow(/timed out/)
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      const deadline = Date.now() + 1_000
      while (!existsSync(pidPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf8').trim())
        try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
      }
      await lock.release()
    }
  })

  it('delivers sanitized diagnostics only to surviving leases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-subscribers-'))
    const dbPath = createArchive(root, 'a@test')
    const executable = createExecutable(root, `console.error('oauth_token=do-not-leak');process.exit(7)`)
    const firstErrors: string[] = []
    const secondErrors: string[] = []
    const leases: MsgvaultSyncRuntimeLease[] = []
    try {
      const first = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable }, (message) => firstErrors.push(message))
      leases.push(first)
      const second = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable }, (message) => secondErrors.push(message))
      leases.push(second)
      firstErrors.length = 0; secondErrors.length = 0
      await first.supervisor?.syncNow('a@test')
      expect(firstErrors).toHaveLength(1)
      expect(secondErrors).toEqual(firstErrors)
      expect(firstErrors[0]).not.toContain('do-not-leak')
      await first.release(); leases.splice(leases.indexOf(first), 1)
      firstErrors.length = 0; secondErrors.length = 0
      await second.supervisor?.syncNow('a@test')
      expect(firstErrors).toEqual([])
      expect(secondErrors).toHaveLength(1)
    } finally {
      await releaseAll(leases)
    }
  })

  it('composes enabled plugin acquisition with Fastify onClose release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-plugin-runtime-'))
    const dbPath = createArchive(root, 'plugin@test')
    const executable = createExecutable(root, `console.log('Changes: 0 processed, 0 added')`)
    const hooks: Array<() => Promise<void>> = []
    const posts: string[] = []
    const plugin = createBoringMailServerPlugin({ workspaceRoot: root, sync: { enabled: true, dbPath, executable } })
    await plugin.routes!({
      log: { warn() {} },
      addHook(name: string, hook: () => Promise<void>) { if (name === 'onClose') hooks.push(hook) },
      post(path: string) { posts.push(path) },
    } as never, {} as never)
    try {
      expect(posts).toEqual(['/api/boring-mail/drafts'])
      expect(hooks).toHaveLength(1)
      expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', root, '/bin/true']).status).toBe(73)
    } finally {
      await hooks[0]?.()
    }
    expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', root, '/bin/true']).status).toBe(0)
  })
})
