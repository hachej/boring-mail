// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { discoverMsgvaultGmailAccounts } from '../src/mail/store/msgvault/gmailAccounts.js'
import {
  classifyMsgvaultSyncOutput,
  createMsgvaultSyncRunner,
} from '../src/mail/sync/msgvaultSyncRunner.js'
import { captureError } from './helpers/msgvaultSyncHarness.js'

describe('msgvault Gmail discovery and sync runner', () => {
  it('preserves exact source spelling through discovery and sync argv', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-accounts-'))
    const dbPath = join(root, 'msgvault.db')
    const db = new DatabaseSync(dbPath)
    db.exec(readFileSync(new URL('./fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8'))
    db.exec(`INSERT INTO sources VALUES(1,'gmail','CaseSensitive@Example.Test'),(2,'imap','skip@example.test')`)
    db.close()

    const accounts = await discoverMsgvaultGmailAccounts({ dbPath })
    expect(accounts).toEqual(['CaseSensitive@Example.Test'])

    const executable = join(root, 'fake-msgvault')
    const argvPath = join(root, 'argv.json')
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ARGV_PATH,JSON.stringify({argv:process.argv.slice(2),direct:process.env.MSGVAULT_DAEMON_CLI_PARENT_PID===String(process.ppid)}));console.log('Changes: 0 processed, 0 added')\n`)
    chmodSync(executable, 0o700)
    const before = process.env.ARGV_PATH
    process.env.ARGV_PATH = argvPath
    try {
      await expect(createMsgvaultSyncRunner({ executable, home: root })(accounts[0]!)).resolves.toEqual({ changed: false })
      expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual({
        argv: ['--home', root, '--no-log-file', 'sync', '--', 'CaseSensitive@Example.Test'],
        direct: true,
      })
    } finally {
      if (before === undefined) delete process.env.ARGV_PATH
      else process.env.ARGV_PATH = before
    }

    for (const invalid of [' CaseSensitive@Example.Test', 'CaseSensitive@Example.Test ', '\u00a0CaseSensitive@Example.Test']) {
      const whitespace = new DatabaseSync(dbPath)
      whitespace.prepare(`UPDATE sources SET identifier=? WHERE id=1`).run(invalid)
      whitespace.close()
      await expect(discoverMsgvaultGmailAccounts({ dbPath })).rejects.toThrow(/identifier is invalid/)
    }
    const restore = new DatabaseSync(dbPath)
    restore.prepare(`UPDATE sources SET identifier=? WHERE id=1`).run('CaseSensitive@Example.Test')
    restore.exec(`INSERT INTO sources VALUES(3,'gmail','casesensitive@example.test')`)
    restore.close()
    await expect(discoverMsgvaultGmailAccounts({ dbPath })).rejects.toThrow(/duplicate/)

    const driftPath = join(root, 'drift.db')
    const drift = new DatabaseSync(driftPath)
    drift.exec(`CREATE TABLE sources(id TEXT,source_type TEXT,identifier TEXT)`)
    drift.close()
    await expect(discoverMsgvaultGmailAccounts({ dbPath: driftPath })).rejects.toThrow(/schema drifted/)
  })

  it('classifies final bounded output and keeps failures redacted', async () => {
    expect(classifyMsgvaultSyncOutput('Changes: 94 processed, 94 added')).toBe('changed')
    expect(classifyMsgvaultSyncOutput('Changes: 0 processed, 0 added')).toBe('empty')
    expect(classifyMsgvaultSyncOutput('Changes: 0 processed, 0 added\nErrors: 400')).toBe('error')
    expect(classifyMsgvaultSyncOutput('Changes: 2 processed, 2 added\nErrors: 1')).toBe('error')
    expect(classifyMsgvaultSyncOutput('updated messages: 2')).toBe('changed')
    expect(classifyMsgvaultSyncOutput('new messages: 0 updated messages: 0')).toBe('empty')
    expect(classifyMsgvaultSyncOutput('summary unavailable')).toBe('unknown')
    expect(classifyMsgvaultSyncOutput('Changes: 2 processed, 2 added\nChanges: 0 processed, 0 added')).toBe('empty')
    expect(classifyMsgvaultSyncOutput('Changes: 0 processed, 0 added\nChanges: 2 processed, 2 added')).toBe('changed')

    const root = mkdtempSync(join(tmpdir(), 'mv-runner-'))
    await expect(createMsgvaultSyncRunner({ executable: join(root, 'missing') })('x@test')).rejects.toThrow(/executable was not found/)

    const failing = join(root, 'failing-msgvault')
    writeFileSync(failing, '#!/usr/bin/env node\nconsole.error("oauth_token=do-not-leak");process.exit(7)\n')
    chmodSync(failing, 0o700)
    const failure = await captureError(createMsgvaultSyncRunner({ executable: failing })('x@test'))
    expect(failure.message).toMatch(/exit 7.*inspect msgvault logs/)
    expect(failure.message).not.toContain('do-not-leak')

    const partial = join(root, 'partial-msgvault')
    writeFileSync(partial, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(70000));console.log("\\nChanges: 0 processed, 0 added\\nErrors: 400")\n')
    chmodSync(partial, 0o700)
    const partialFailure = await captureError(createMsgvaultSyncRunner({ executable: partial })('-user@example.test'))
    expect(partialFailure.message).toMatch(/completed with item errors/)
    expect(partialFailure.message).not.toContain('400')

    writeFileSync(partial, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(70000));console.log("\\nChanges: 0 processed, 0 added\\nErrors: 0")\n')
    await expect(createMsgvaultSyncRunner({ executable: partial })('-user@example.test')).resolves.toEqual({ changed: false })
  })
})
