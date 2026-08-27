// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { discoverMsgvaultGmailAccounts } from '../src/mail/store/msgvault/gmailAccounts.js'
import {
  appendBoundedMsgvaultOutputTail,
  classifyMsgvaultSyncOutput,
  createMsgvaultSyncRunner,
  MSGVAULT_OUTPUT_TAIL_BYTES,
  serializeMsgvaultSyncRunner,
  StickyMsgvaultItemErrorDetector,
} from '../src/mail/sync/msgvaultSyncRunner.js'
import { captureError, deferred, flush } from './helpers/msgvaultSyncHarness.js'

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

  it('serializes direct writers FIFO across accounts and continues after failure', async () => {
    const gates = [deferred<{ changed: boolean }>(), deferred<{ changed: boolean }>(), deferred<{ changed: boolean }>()]
    const started: string[] = []
    let running = 0
    let maxRunning = 0
    const serialized = serializeMsgvaultSyncRunner(async (account) => {
      started.push(account)
      running++
      maxRunning = Math.max(maxRunning, running)
      const gate = gates[started.length - 1]!
      try { return await gate.promise } finally { running-- }
    })
    const first = serialized('a@test')
    const second = serialized('b@test')
    const third = serialized('c@test')
    await flush()
    expect(started).toEqual(['a@test'])
    gates[0]!.resolve({ changed: true }); await first; await flush()
    expect(started).toEqual(['a@test', 'b@test'])
    gates[1]!.reject(new Error('synthetic')); await expect(second).rejects.toThrow(/synthetic/); await flush()
    expect(started).toEqual(['a@test', 'b@test', 'c@test'])
    gates[2]!.resolve({ changed: false })
    await expect(third).resolves.toEqual({ changed: false })
    expect(maxRunning).toBe(1)
  })

  it('detects sticky item errors across arbitrary UTF-8 chunks without crossing streams', () => {
    const split = new StickyMsgvaultItemErrorDetector()
    for (const chunk of ['E', 'rro', 'rs', ':', ' ', '0', '4']) split.push(chunk)
    expect(split.finish()).toBe(true)

    for (const whitespace of ['\u00a0', '\u2028']) {
      const encoded = Buffer.from(`!Errors:${whitespace}01;`, 'utf8')
      const detector = new StickyMsgvaultItemErrorDetector()
      for (let index = 0; index < encoded.length; index++) {
        detector.push(encoded.subarray(index, index + 1))
      }
      expect(detector.finish()).toBe(true)
      expect(classifyMsgvaultSyncOutput(`Errors:${whitespace}01`)).toBe('error')
    }

    for (const output of ['xErrors: 1', '_Errors: 1', 'Errors: 1x', 'Errors: 1_']) {
      const detector = new StickyMsgvaultItemErrorDetector()
      detector.push(output)
      expect(detector.finish()).toBe(false)
    }
    for (const output of ['Errors: 1', '!Errors: 1;', '\u00e9Errors: 1.']) {
      const detector = new StickyMsgvaultItemErrorDetector()
      detector.push(output)
      expect(detector.finish()).toBe(true)
    }

    const huge = new StickyMsgvaultItemErrorDetector()
    huge.push(Buffer.from(`Errors: 1\n${'x'.repeat(70_000)}`))
    expect(huge.finish()).toBe(true)

    const sticky = new StickyMsgvaultItemErrorDetector()
    sticky.push('Errors: 7\n')
    sticky.push('Errors: 0\n')
    expect(sticky.finish()).toBe(true)

    const zero = new StickyMsgvaultItemErrorDetector()
    zero.push('Errors: ')
    zero.push('000\n')
    expect(zero.finish()).toBe(false)

    const stdout = new StickyMsgvaultItemErrorDetector()
    const stderr = new StickyMsgvaultItemErrorDetector()
    stdout.push('Err')
    stderr.push('ors: 9\n')
    expect(stdout.finish()).toBe(false)
    expect(stderr.finish()).toBe(false)
  })

  it('copies every bounded output-tail path into a bounded backing allocation', () => {
    const suffix = Buffer.from('physical-tail-sentinel')
    const huge = Buffer.alloc(MSGVAULT_OUTPUT_TAIL_BYTES * 48, 120)
    suffix.copy(huge, huge.length - suffix.length)
    const hugeTail = appendBoundedMsgvaultOutputTail(Buffer.alloc(0), huge)
    expect(hugeTail).toHaveLength(MSGVAULT_OUTPUT_TAIL_BYTES)
    expect(hugeTail.buffer.byteLength).toBeLessThanOrEqual(MSGVAULT_OUTPUT_TAIL_BYTES)
    expect(hugeTail.subarray(-suffix.length)).toEqual(suffix)

    const sharedParent = Buffer.alloc(MSGVAULT_OUTPUT_TAIL_BYTES * 4, 121)
    const sharedSlice = sharedParent.subarray(100, 120)
    const fittingTail = appendBoundedMsgvaultOutputTail(Buffer.alloc(0), sharedSlice)
    expect(fittingTail).toEqual(sharedSlice)
    expect(fittingTail.buffer.byteLength).toBeLessThanOrEqual(MSGVAULT_OUTPUT_TAIL_BYTES)

    const overflowTail = appendBoundedMsgvaultOutputTail(hugeTail, sharedSlice)
    expect(overflowTail).toHaveLength(MSGVAULT_OUTPUT_TAIL_BYTES)
    expect(overflowTail.buffer.byteLength).toBeLessThanOrEqual(MSGVAULT_OUTPUT_TAIL_BYTES)
    expect(overflowTail.subarray(-sharedSlice.length)).toEqual(sharedSlice)
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

  it('keeps streamed item errors sticky after tail eviction and across independent streams', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sticky-errors-'))
    const executable = join(root, 'fake-msgvault')

    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write('Changes: 0 processed, 0 added\\nErrors: 1\\n')
process.stdout.write('x'.repeat(70_000))
`)
    chmodSync(executable, 0o700)
    let failure = await captureError(createMsgvaultSyncRunner({ executable })('x@test'))
    expect(failure.message).toMatch(/completed with item errors/)
    expect(failure.message).not.toContain('Errors: 1')

    writeFileSync(executable, `#!/usr/bin/env node
process.stderr.write('Errors: 2\\n')
process.stdout.write('x'.repeat(70_000))
process.stdout.write('\\nChanges: 0 processed, 0 added\\n')
`)
    failure = await captureError(createMsgvaultSyncRunner({ executable })('x@test'))
    expect(failure.message).toMatch(/completed with item errors/)
    expect(failure.message).not.toContain('Errors: 2')

    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write('Errors: 3\\n')
process.stdout.write('x'.repeat(70_000))
process.stdout.write('\\nErrors: 0\\nChanges: 0 processed, 0 added\\n')
`)
    await expect(createMsgvaultSyncRunner({ executable })('x@test')).rejects.toThrow(/completed with item errors/)

    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write('Errors: 0\\n')
process.stdout.write('x'.repeat(70_000))
process.stdout.write('\\nChanges: 0 processed, 0 added\\n')
`)
    await expect(createMsgvaultSyncRunner({ executable })('x@test')).resolves.toEqual({ changed: false })

    writeFileSync(executable, `#!/usr/bin/env node
const bytes = Buffer.from('Errors:\\u00a01\\nChanges: 0 processed, 0 added\\n')
for (const byte of bytes) process.stdout.write(Buffer.of(byte))
`)
    await expect(createMsgvaultSyncRunner({ executable })('x@test')).rejects.toThrow(/completed with item errors/)

    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write('Err')
process.stderr.write('ors: 9\\n')
process.stdout.write('\\nChanges: 0 processed, 0 added\\n')
`)
    await expect(createMsgvaultSyncRunner({ executable })('x@test')).resolves.toEqual({ changed: false })
  })
})
