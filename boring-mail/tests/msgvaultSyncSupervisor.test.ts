// @vitest-environment node
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import createBoringMailServerPlugin from '../src/boring-ui/server.js'
import { discoverMsgvaultGmailAccounts } from '../src/mail/sync/msgvaultAccounts.js'
import { acquireSyncSupervisorSingleton } from '../src/mail/sync/msgvaultSyncRuntime.js'
import {
  classifyMsgvaultSyncOutput,
  createMsgvaultSyncRunner,
} from '../src/mail/sync/msgvaultSyncRunner.js'
import {
  MsgvaultSyncSupervisor,
  type MsgvaultSyncSupervisorDependencies,
} from '../src/mail/sync/msgvaultSyncSupervisor.js'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

class FakeClock {
  now = 0
  nextId = 1
  timers = new Map<number, { due: number; callback: () => void }>()
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++
    this.timers.set(id, { due: this.now + delay, callback })
    return id
  }
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number) }
  async advance(ms: number) {
    this.now += ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= this.now)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
      if (!due) break
      this.timers.delete(due[0])
      due[1].callback()
      await flush()
    }
  }
  delays() { return [...this.timers.values()].map((timer) => timer.due - this.now).sort((a, b) => a - b) }
}

function harness(
  accounts: string[],
  syncAccount: MsgvaultSyncSupervisorDependencies['syncAccount'],
  random = () => 0.5,
  options: ConstructorParameters<typeof MsgvaultSyncSupervisor>[1] = {},
) {
  const clock = new FakeClock()
  const supervisor = new MsgvaultSyncSupervisor({
    discoverAccounts: async () => accounts,
    syncAccount,
    now: () => clock.now,
    random,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }, { heartbeatMs: 1_000_000, suspendLateAfterMs: 1_000_000, ...options })
  return { clock, supervisor }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('MsgvaultSyncSupervisor', () => {
  it('starts immediately and schedules active jitter only after completion', async () => {
    const pending = deferred<{ changed: boolean }>()
    const { clock, supervisor } = harness(['a@example.test'], async () => pending.promise, () => 0)
    await supervisor.start()
    expect(clock.delays()).toContain(0)
    await clock.advance(0)
    expect(supervisor.health()[0]).toMatchObject({ inFlight: true, nextRunAt: null })
    expect(clock.delays()).not.toContain(96_000)
    pending.resolve({ changed: true })
    await flush()
    expect(supervisor.health()[0]).toMatchObject({ inFlight: false, consecutiveEmpty: 0, lastSuccessAgeMs: 0 })
    expect(Object.isFrozen(supervisor.health())).toBe(true)
    expect(clock.delays()).toContain(96_000)
    await supervisor.stop()
  })

  it('keeps active jitter inside the configured plus/minus twenty percent range', async () => {
    const { clock, supervisor } = harness(['a@test'], async () => ({ changed: true }), () => 0.999999)
    await supervisor.start(); await clock.advance(0)
    expect(clock.delays()).toContain(144_000)
    await supervisor.stop()
  })

  it('backs off after three empties and resets on change', async () => {
    const results = [false, false, false, true]
    const randoms = [0.5, 0.5, 0.25, 0.5]
    const { clock, supervisor } = harness(
      ['a@example.test'],
      async () => ({ changed: results.shift() ?? true }),
      () => randoms.shift() ?? 0.5,
    )
    await supervisor.start()
    await clock.advance(0)
    for (let i = 0; i < 2; i++) await supervisor.syncNow('a@example.test')
    expect(supervisor.health()[0]?.consecutiveEmpty).toBe(3)
    expect(clock.delays()).toContain(375_000)
    await supervisor.syncNow('a@example.test')
    expect(supervisor.health()[0]?.consecutiveEmpty).toBe(0)
    expect(clock.delays()).toContain(120_000)
    await supervisor.stop()
  })

  it('coalesces same-account triggers while allowing cross-account concurrency', async () => {
    const queues = new Map<string, Array<ReturnType<typeof deferred<{ changed: boolean }>>>>()
    const running = new Map<string, number>()
    const maxRunning = new Map<string, number>()
    let totalRunning = 0, maxTotal = 0
    const { clock, supervisor } = harness(['a@test', 'b@test'], async (account) => {
      running.set(account, (running.get(account) ?? 0) + 1)
      maxRunning.set(account, Math.max(maxRunning.get(account) ?? 0, running.get(account)!))
      totalRunning++; maxTotal = Math.max(maxTotal, totalRunning)
      const item = deferred<{ changed: boolean }>()
      queues.set(account, [...(queues.get(account) ?? []), item])
      return item.promise.finally(() => { running.set(account, running.get(account)! - 1); totalRunning-- })
    })
    await supervisor.start()
    await clock.advance(0)
    const p1 = supervisor.syncNow('a@test')
    const p2 = supervisor.syncNow('a@test')
    expect(maxTotal).toBe(2)
    expect(maxRunning.get('a@test')).toBe(1)
    queues.get('a@test')![0]!.resolve({ changed: true })
    await flush()
    expect(queues.get('a@test')).toHaveLength(2)
    queues.get('a@test')![1]!.resolve({ changed: true })
    queues.get('b@test')![0]!.resolve({ changed: true })
    await Promise.all([p1, p2])
    expect(maxRunning.get('a@test')).toBe(1)
    expect(queues.get('a@test')).toHaveLength(2)
    await supervisor.stop()
  })

  it('detects suspend lateness and issues one all-account wave', async () => {
    const calls: string[] = []
    const { clock, supervisor } = harness(
      ['a@test', 'b@test'],
      async (account) => { calls.push(account); return { changed: true } },
      () => 0.5,
      { activeIntervalMs: 1_000_000, heartbeatMs: 10, suspendLateAfterMs: 5 },
    )
    await supervisor.start()
    await clock.advance(0)
    calls.length = 0
    await clock.advance(30)
    await flush()
    expect(calls.sort()).toEqual(['a@test', 'b@test'])
    await supervisor.stop()
  })

  it('drains children on shutdown, suppresses reruns, and sanitizes health errors', async () => {
    const pending = deferred<{ changed: boolean }>()
    let calls = 0
    const { clock, supervisor } = harness(['secret@example.test'], async () => {
      calls++
      if (calls === 1) return pending.promise
      throw new Error('oauth_token=abc secret@example.test\nprivate second line')
    })
    await supervisor.start()
    await clock.advance(0)
    void supervisor.syncNow('secret@example.test')
    let stopped = false
    const stop = supervisor.stop().then(() => { stopped = true })
    await flush()
    expect(stopped).toBe(false)
    pending.resolve({ changed: true })
    await stop
    expect(calls).toBe(1)
    expect(clock.timers.size).toBe(0)

    const second = harness(['secret@example.test'], async () => { throw new Error('oauth_token=abc secret@example.test\nprivate') })
    await second.supervisor.start(); await second.clock.advance(0)
    const health = second.supervisor.health()[0]!
    expect(health.lastError).toBe('[credential redacted] [account]')
    expect(Object.isFrozen(health)).toBe(true)
    await second.supervisor.stop()
  })
})

describe('msgvault discovery, runner and singleton', () => {
  it('discovers normalized Gmail accounts and fails closed on drift/duplicates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-accounts-'))
    const path = join(root, 'msgvault.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE sources(id INTEGER PRIMARY KEY,source_type TEXT NOT NULL,identifier TEXT NOT NULL);
      INSERT INTO sources VALUES(1,'gmail','A@Example.Test'),(2,'imap','skip@example.test')`)
    db.close()
    await expect(discoverMsgvaultGmailAccounts({ dbPath: path })).resolves.toEqual(['a@example.test'])

    const duplicate = new DatabaseSync(path)
    duplicate.exec(`INSERT INTO sources VALUES(3,'gmail','a@example.test')`)
    duplicate.close()
    await expect(discoverMsgvaultGmailAccounts({ dbPath: path })).rejects.toThrow(/duplicate/)

    const driftPath = join(root, 'drift.db')
    const drift = new DatabaseSync(driftPath)
    drift.exec(`CREATE TABLE sources(id TEXT,source_type TEXT,identifier TEXT)`); drift.close()
    await expect(discoverMsgvaultGmailAccounts({ dbPath: driftPath })).rejects.toThrow(/schema drifted/)
  })

  it('classifies output and spawns direct safe argv with bounded errors', async () => {
    expect(classifyMsgvaultSyncOutput('Changes: 94 processed, 94 added')).toBe('changed')
    expect(classifyMsgvaultSyncOutput('Changes: 0 processed, 0 added')).toBe('empty')
    expect(classifyMsgvaultSyncOutput('updated messages: 2')).toBe('changed')
    expect(classifyMsgvaultSyncOutput('new messages: 0 updated messages: 0')).toBe('empty')
    expect(classifyMsgvaultSyncOutput('summary unavailable')).toBe('unknown')

    const root = mkdtempSync(join(tmpdir(), 'mv-runner-'))
    const executable = join(root, 'fake-msgvault')
    const argvPath = join(root, 'argv.json')
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ARGV_PATH,JSON.stringify(process.argv.slice(2)));console.log('updated messages: 2')\n`)
    chmodSync(executable, 0o700)
    const before = process.env.ARGV_PATH
    process.env.ARGV_PATH = argvPath
    try {
      await expect(createMsgvaultSyncRunner({ executable, home: root })('synthetic@example.test')).resolves.toEqual({ changed: true })
      expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual([
        '--home', root, '--no-log-file', 'sync', 'synthetic@example.test',
      ])
    } finally {
      if (before === undefined) delete process.env.ARGV_PATH
      else process.env.ARGV_PATH = before
    }
    await expect(createMsgvaultSyncRunner({ executable: join(root, 'missing') })('x@test')).rejects.toThrow(/executable was not found/)

    const failing = join(root, 'failing-msgvault')
    writeFileSync(failing, '#!/usr/bin/env node\nconsole.error("oauth_token=do-not-leak");process.exit(7)\n'); chmodSync(failing, 0o700)
    await expect(createMsgvaultSyncRunner({ executable: failing })('x@test')).rejects.toThrow(/exit 7.*inspect msgvault logs/)
  })

  it('registers sync shutdown on the server lifecycle without disturbing routes', async () => {
    const hooks: Array<() => Promise<void>> = []
    const posts: string[] = []
    const plugin = createBoringMailServerPlugin({ workspaceRoot: '/tmp', sync: false })
    await plugin.routes!({
      addHook(name: string, hook: () => Promise<void>) {
        if (name === 'onClose') hooks.push(hook)
      },
      post(path: string) { posts.push(path) },
    } as never, {} as never)
    expect(posts).toEqual(['/api/boring-mail/drafts'])
    expect(hooks).toHaveLength(1)
    await hooks[0]!()
  })

  it('reference-counts one process singleton and stops only on final release', async () => {
    let starts = 0, runs = 0
    const clock = new FakeClock()
    const create = () => {
      starts++
      return new MsgvaultSyncSupervisor({
        discoverAccounts: async () => ['a@test'],
        syncAccount: async () => { runs++; return { changed: true } },
        now: () => clock.now,
        random: () => 0.5,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }, { heartbeatMs: 1_000_000, suspendLateAfterMs: 1_000_000 })
    }
    const key = `test-${Date.now()}-${Math.random()}`
    const [first, second] = await Promise.all([
      acquireSyncSupervisorSingleton(key, create),
      acquireSyncSupervisorSingleton(key, create),
    ])
    expect(starts).toBe(1)
    expect(first.supervisor).toBe(second.supervisor)
    await clock.advance(0)
    expect(runs).toBe(1)
    await first.release()
    expect(clock.timers.size).toBeGreaterThan(0)
    await second.release()
    expect(clock.timers.size).toBe(0)
  })
})
