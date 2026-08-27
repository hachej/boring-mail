// @vitest-environment node
import { spawnSync } from 'node:child_process'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import createBoringMailServerPlugin from '../src/boring-ui/server.js'
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

function createExecutable(root: string, body: string): string {
  const executable = join(root, 'fake-msgvault')
  writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`)
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
        '--home', '/proc/self/fd/3', '--no-log-file', 'sync', '--', 'CaseSensitive@Example.Test',
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
