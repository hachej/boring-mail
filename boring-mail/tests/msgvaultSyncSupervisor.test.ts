// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import createBoringMailServerPlugin from '../src/boring-ui/server.js'
import { discoverMsgvaultGmailAccounts } from '../src/mail/sync/msgvaultAccounts.js'
import { acquireMsgvaultArchiveLock } from '../src/mail/sync/msgvaultArchiveLock.js'
import {
  acquireMsgvaultSyncRuntime,
  acquireSyncSupervisorSingleton,
  resolveMsgvaultArchive,
} from '../src/mail/sync/msgvaultSyncRuntime.js'
import {
  classifyMsgvaultSyncOutput,
  createMsgvaultSyncRunner,
} from '../src/mail/sync/msgvaultSyncRunner.js'
import {
  MAX_TIMER_DELAY_MS,
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

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try { await promise }
  catch (error) { return error instanceof Error ? error : new Error(String(error)) }
  throw new Error('expected promise to reject')
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for synthetic child')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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

  it('discovers additions and removals during ordinary heartbeats', async () => {
    const accounts = ['a@test']
    const calls: string[] = []
    const { clock, supervisor } = harness(accounts, async (account) => {
      calls.push(account)
      return { changed: true }
    }, () => 0.5, { activeIntervalMs: 1_000_000, heartbeatMs: 10, suspendLateAfterMs: 1_000 })
    await supervisor.start(); await clock.advance(0)
    calls.length = 0
    accounts.splice(0, 1, 'b@test')
    await clock.advance(10); await flush()
    expect(calls).toEqual(['b@test'])
    expect(supervisor.health().map((health) => health.account)).toEqual(['b@test'])
    await supervisor.stop()
  })

  it('coalesces a second suspend during a long resume wave into one follow-up', async () => {
    const pending = deferred<{ changed: boolean }>()
    let calls = 0
    const { clock, supervisor } = harness(['a@test'], async () => {
      calls++
      if (calls === 2) return pending.promise
      return { changed: true }
    }, () => 0.5, { activeIntervalMs: 1_000_000, heartbeatMs: 10, suspendLateAfterMs: 5 })
    await supervisor.start(); await clock.advance(0)
    await clock.advance(30)
    expect(calls).toBe(2)
    await clock.advance(30)
    pending.resolve({ changed: true })
    for (let i = 0; i < 24; i++) await Promise.resolve()
    expect(calls).toBe(3)
    await supervisor.stop()
  })

  it('linearizes concurrent start/stop and cleans partial timer startup', async () => {
    const discovery = deferred<string[]>()
    const clock = new FakeClock()
    const supervisor = new MsgvaultSyncSupervisor({
      discoverAccounts: () => discovery.promise,
      syncAccount: async () => ({ changed: true }),
      now: () => clock.now,
      random: () => 0.5,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    const firstStart = supervisor.start()
    expect(supervisor.start()).toBe(firstStart)
    const firstStop = supervisor.stop()
    expect(supervisor.stop()).toBe(firstStop)
    discovery.resolve(['a@test'])
    await Promise.all([firstStart, firstStop])
    expect(clock.timers.size).toBe(0)
    expect(supervisor.health()).toHaveLength(0)

    let schedules = 0
    const partial = new MsgvaultSyncSupervisor({
      discoverAccounts: async () => ['a@test', 'b@test'],
      syncAccount: async () => ({ changed: true }),
      now: () => clock.now,
      random: () => 0.5,
      setTimeout(callback, delay) {
        schedules++
        if (schedules === 2) throw new Error('timer unavailable')
        return clock.setTimeout(callback, delay)
      },
      clearTimeout: clock.clearTimeout,
    })
    await expect(partial.start()).rejects.toThrow(/timer unavailable/)
    expect(clock.timers.size).toBe(0)
    await partial.stop()
  })

  it('rejects unsafe thresholds and guarantees positive custom delays', async () => {
    const deps: MsgvaultSyncSupervisorDependencies = {
      discoverAccounts: async () => ['a@test'],
      syncAccount: async () => ({ changed: true }),
      now: () => 0,
      random: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    }
    expect(() => new MsgvaultSyncSupervisor(deps, { idleAfterEmptyRuns: 0.5 })).toThrow(/positive safe integer/)
    expect(() => new MsgvaultSyncSupervisor(deps, { activeJitterFraction: 1 })).toThrow(/less than one/)
    const delays: number[] = []
    const tiny = new MsgvaultSyncSupervisor({ ...deps, setTimeout: (_callback, delay) => { delays.push(delay); return 1 } }, {
      activeIntervalMs: 0.1,
      activeJitterFraction: 0.9,
      heartbeatMs: 1_000,
      suspendLateAfterMs: 1_000,
    })
    await tiny.start()
    expect(delays[0]).toBe(0)
    await tiny.syncNow('a@test')
    expect(delays).toContain(1)
    await tiny.stop()
    expect(() => new MsgvaultSyncSupervisor(deps, { heartbeatMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/no greater/)
    expect(() => new MsgvaultSyncSupervisor(deps, {
      activeIntervalMs: MAX_TIMER_DELAY_MS,
      activeJitterFraction: 0.2,
    })).toThrow(/jitter upper bound/)
  })

  it('recovers a failed post-run timer arm on the next heartbeat', async () => {
    const clock = new FakeClock()
    const errors: string[] = []
    let failed = false, calls = 0
    const supervisor = new MsgvaultSyncSupervisor({
      discoverAccounts: async () => ['a@test'],
      syncAccount: async () => { calls++; return { changed: true } },
      now: () => clock.now,
      random: () => 0.5,
      setTimeout(callback, delay) {
        if (delay === 1_000 && !failed) { failed = true; throw new Error('timer arm failed') }
        return clock.setTimeout(callback, delay)
      },
      clearTimeout: clock.clearTimeout,
      onError: (message) => errors.push(message),
    }, { activeIntervalMs: 1_000, heartbeatMs: 10, suspendLateAfterMs: 1_000 })
    await supervisor.start(); await clock.advance(0); await flush()
    expect(supervisor.health()[0]).toMatchObject({ nextRunAt: null, lastError: 'timer arm failed' })
    await clock.advance(10); await flush()
    expect(calls).toBe(2)
    expect(errors).toContain('timer arm failed')
    await supervisor.stop()
  })

  it('executes heartbeat work when rearm fails and drains despite clear failures', async () => {
    const clock = new FakeClock()
    const accounts = ['a@test']
    const pending = deferred<{ changed: boolean }>()
    const calls: string[] = []
    const errors: string[] = []
    let heartbeatArms = 0
    const supervisor = new MsgvaultSyncSupervisor({
      discoverAccounts: async () => accounts,
      syncAccount: async (account) => {
        calls.push(account)
        if (account === 'a@test') return pending.promise
        return { changed: true }
      },
      now: () => clock.now,
      random: () => 0.5,
      setTimeout(callback, delay) {
        if (delay === 10 && ++heartbeatArms === 2) throw new Error('heartbeat rearm failed')
        return clock.setTimeout(callback, delay)
      },
      clearTimeout(handle) {
        clock.clearTimeout(handle)
        throw new Error('clear failed')
      },
      onError: (message) => errors.push(message),
    }, { activeIntervalMs: 1_000, heartbeatMs: 10, suspendLateAfterMs: 1_000 })
    await supervisor.start(); await clock.advance(0)
    accounts.push('b@test')
    await clock.advance(10); await flush()
    expect(calls).toContain('b@test')
    expect(errors).toContain('heartbeat rearm failed')
    let stopped = false
    const stop = supervisor.stop().then(() => { stopped = true })
    await flush()
    expect(stopped).toBe(false)
    pending.resolve({ changed: true })
    await stop
    expect(errors).toContain('clear failed')
  })

  it('coalesces remove and re-add during an in-flight run and rejects restart after stop', async () => {
    const clock = new FakeClock()
    const accounts = ['a@test']
    const first = deferred<{ changed: boolean }>()
    let calls = 0
    const supervisor = new MsgvaultSyncSupervisor({
      discoverAccounts: async () => accounts,
      syncAccount: async () => { calls++; return calls === 1 ? first.promise : { changed: true } },
      now: () => clock.now,
      random: () => 0.5,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }, { activeIntervalMs: 1_000, heartbeatMs: 10, suspendLateAfterMs: 1_000 })
    await supervisor.start(); await clock.advance(0)
    accounts.splice(0)
    await clock.advance(10)
    accounts.push('a@test')
    await clock.advance(10)
    first.resolve({ changed: true })
    await flush()
    expect(calls).toBe(2)
    const stopping = supervisor.stop()
    await expect(supervisor.start()).rejects.toThrow(/stopping/)
    await stopping
    await expect(supervisor.start()).rejects.toThrow(/stopping/)
  })
})

describe('msgvault discovery, runner and singleton', () => {
  it('discovers normalized Gmail accounts and fails closed on drift/duplicates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-accounts-'))
    const path = join(root, 'msgvault.db')
    const db = new DatabaseSync(path)
    db.exec(readFileSync(new URL('./fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8'))
    db.exec(`INSERT INTO sources VALUES(1,'gmail','A@Example.Test'),(2,'imap','skip@example.test')`)
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
    expect(classifyMsgvaultSyncOutput('Changes: 0 processed, 0 added\nErrors: 400')).toBe('error')
    expect(classifyMsgvaultSyncOutput('Changes: 2 processed, 2 added\nErrors: 1')).toBe('error')
    expect(classifyMsgvaultSyncOutput('updated messages: 2')).toBe('changed')
    expect(classifyMsgvaultSyncOutput('new messages: 0 updated messages: 0')).toBe('empty')
    expect(classifyMsgvaultSyncOutput('summary unavailable')).toBe('unknown')
    expect(classifyMsgvaultSyncOutput('Changes: 2 processed, 2 added\nChanges: 0 processed, 0 added')).toBe('empty')
    expect(classifyMsgvaultSyncOutput('Changes: 0 processed, 0 added\nChanges: 2 processed, 2 added')).toBe('changed')

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
        '--home', root, '--no-log-file', 'sync', '--', 'synthetic@example.test',
      ])
    } finally {
      if (before === undefined) delete process.env.ARGV_PATH
      else process.env.ARGV_PATH = before
    }
    await expect(createMsgvaultSyncRunner({ executable: join(root, 'missing') })('x@test')).rejects.toThrow(/executable was not found/)

    const failing = join(root, 'failing-msgvault')
    writeFileSync(failing, '#!/usr/bin/env node\nconsole.error("oauth_token=do-not-leak");process.exit(7)\n'); chmodSync(failing, 0o700)
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

  it('keeps custom database discovery and CLI home coherent', async () => {
    const defaultBase = mkdtempSync(join(tmpdir(), 'mv-default-'))
    const defaultRoot = join(defaultBase, '.msgvault')
    mkdirSync(defaultRoot)
    const customRoot = mkdtempSync(join(tmpdir(), 'mv-custom-'))
    for (const [root, account] of [[defaultRoot, 'default@test'], [customRoot, 'custom@test']] as const) {
      const db = new DatabaseSync(join(root, 'msgvault.db'))
      db.exec(`CREATE TABLE sources(id INTEGER PRIMARY KEY,source_type TEXT NOT NULL,identifier TEXT NOT NULL);
        INSERT INTO sources VALUES(1,'gmail','${account}')`)
      db.close()
    }
    expect(resolveMsgvaultArchive({}, {
      HOME: defaultBase,
      MSGVAULT_DB_PATH: join(customRoot, 'msgvault.db'),
    })).toEqual({ home: customRoot, dbPath: join(customRoot, 'msgvault.db') })
    expect(() => resolveMsgvaultArchive({}, {
      MSGVAULT_HOME: defaultRoot,
      MSGVAULT_DB_PATH: join(customRoot, 'msgvault.db'),
    })).toThrow(/home and database conflict/)
    expect(() => resolveMsgvaultArchive({ dbPath: join(customRoot, 'archive.db') }, {})).toThrow(/<home>\/msgvault.db/)

    const executable = join(customRoot, 'fake-msgvault')
    const executableAlias = join(customRoot, 'msgvault-alias')
    const argvPath = join(customRoot, 'runtime-argv.json')
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ARGV_PATH,JSON.stringify(process.argv.slice(2)));console.log('Changes: 0 processed, 0 added')\n`)
    chmodSync(executable, 0o700)
    symlinkSync(executable, executableAlias)
    const clock = new FakeClock()
    const injected = {
      now: () => clock.now,
      random: () => 0.5,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }
    const before = process.env.ARGV_PATH
    process.env.ARGV_PATH = argvPath
    try {
      const first = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath: join(customRoot, 'msgvault.db'), executable }, injected)
      const second = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath: join(customRoot, 'msgvault.db'), executable: executableAlias }, injected)
      const previousDb = process.env.MSGVAULT_DB_PATH
      const previousHome = process.env.MSGVAULT_HOME
      let blankHints: Awaited<ReturnType<typeof acquireMsgvaultSyncRuntime>>
      try {
        process.env.MSGVAULT_DB_PATH = join(customRoot, 'msgvault.db')
        delete process.env.MSGVAULT_HOME
        blankHints = await acquireMsgvaultSyncRuntime({ home: '   ', dbPath: '   ', executable }, injected)
      } finally {
        if (previousDb === undefined) delete process.env.MSGVAULT_DB_PATH
        else process.env.MSGVAULT_DB_PATH = previousDb
        if (previousHome === undefined) delete process.env.MSGVAULT_HOME
        else process.env.MSGVAULT_HOME = previousHome
      }
      expect(second.supervisor).toBe(first.supervisor)
      expect(blankHints.supervisor).toBe(first.supervisor)
      expect(first.supervisor?.health().map((health) => health.account)).toEqual(['custom@test'])
      await first.supervisor?.syncNow('custom@test')
      expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual([
        '--home', '/proc/self/fd/3', '--no-log-file', 'sync', '--', 'custom@test',
      ])
      await expect(acquireMsgvaultSyncRuntime({
        enabled: true,
        dbPath: join(customRoot, 'msgvault.db'),
        executable,
        activeIntervalMs: 121_000,
      }, injected)).rejects.toThrow(/conflicting sync supervisor configuration/)

      const contended = spawnSync('flock', ['-n', '-E', '73', customRoot, '/bin/true'])
      expect(contended.status).toBe(73)
      await first.release()
      await blankHints.release()
      expect(spawnSync('flock', ['-n', '-E', '73', customRoot, '/bin/true']).status).toBe(73)
      await second.release()
      expect(spawnSync('flock', ['-n', '-E', '73', customRoot, '/bin/true']).status).toBe(0)
    } finally {
      if (before === undefined) delete process.env.ARGV_PATH
      else process.env.ARGV_PATH = before
    }
  })

  it('holds and releases cross-process archive inode ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-lock-'))
    const dbPath = join(root, 'msgvault.db')
    writeFileSync(dbPath, '')
    const lock = await acquireMsgvaultArchiveLock(dbPath)
    expect(spawnSync('flock', ['-n', '-E', '73', dbPath, '/bin/true']).status).toBe(73)
    await lock.release()
    expect(spawnSync('flock', ['-n', '-E', '73', dbPath, '/bin/true']).status).toBe(0)
  })

  it('retains ownership after holder death until parent descriptors release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-holder-death-'))
    const dbPath = join(root, 'msgvault.db')
    writeFileSync(dbPath, '')
    const lock = await acquireMsgvaultArchiveLock(dbPath)
    process.kill(lock.holderPid, 'SIGKILL')
    await lock.holderClosed
    expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', dbPath, '/bin/true']).status).toBe(73)
    await lock.release()
    expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', dbPath, '/bin/true']).status).toBe(0)
  })

  it('keeps ownership on an inherited sync child after owner descriptors close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-child-lock-'))
    const dbPath = join(root, 'msgvault.db')
    const executable = join(root, 'fake-msgvault')
    const readyPath = join(root, 'ready')
    const finishPath = join(root, 'finish')
    writeFileSync(dbPath, '')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs');fs.fstatSync(3);fs.fstatSync(4);fs.writeFileSync(process.env.READY_PATH,'');
const wait=()=>fs.existsSync(process.env.FINISH_PATH)?console.log('Changes: 0 processed, 0 added'):setTimeout(wait,10);wait();
`)
    chmodSync(executable, 0o700)
    const previousReady = process.env.READY_PATH
    const previousFinish = process.env.FINISH_PATH
    process.env.READY_PATH = readyPath
    process.env.FINISH_PATH = finishPath
    try {
      const lock = await acquireMsgvaultArchiveLock(dbPath)
      const running = createMsgvaultSyncRunner({ executable, archiveLock: lock })('a@test')
      await waitForFile(readyPath)
      process.kill(lock.holderPid, 'SIGKILL')
      await lock.holderClosed
      await lock.release()
      expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', dbPath, '/bin/true']).status).toBe(73)
      writeFileSync(finishPath, '')
      await expect(running).resolves.toEqual({ changed: false })
      expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', dbPath, '/bin/true']).status).toBe(0)
    } finally {
      if (previousReady === undefined) delete process.env.READY_PATH
      else process.env.READY_PATH = previousReady
      if (previousFinish === undefined) delete process.env.FINISH_PATH
      else process.env.FINISH_PATH = previousFinish
    }
  })

  it('pins ownership utilities, rejects FIFO archives, and fails closed on home replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-lock-hardening-'))
    const dbPath = join(root, 'msgvault.db')
    writeFileSync(dbPath, '')
    const fakeBin = mkdtempSync(join(tmpdir(), 'mv-fake-path-'))
    writeFileSync(join(fakeBin, 'flock'), '#!/bin/sh\nprintf "ready\\n"\n'); chmodSync(join(fakeBin, 'flock'), 0o700)
    const previousPath = process.env.PATH
    process.env.PATH = fakeBin
    try {
      const lock = await acquireMsgvaultArchiveLock(dbPath)
      expect(spawnSync('/usr/bin/flock', ['-n', '-E', '73', dbPath, '/bin/true']).status).toBe(73)
      const moved = `${root}-moved`
      renameSync(root, moved)
      mkdirSync(root)
      writeFileSync(join(root, 'msgvault.db'), '')
      expect(() => lock.databasePath()).toThrow(/identity changed/)
      expect(() => lock.spawnContext()).toThrow(/identity changed/)
      await lock.release()
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }

    const fifoRoot = mkdtempSync(join(tmpdir(), 'mv-fifo-'))
    const fifoPath = join(fifoRoot, 'msgvault.db')
    expect(spawnSync('/usr/bin/mkfifo', [fifoPath]).status).toBe(0)
    const started = Date.now()
    await expect(acquireMsgvaultArchiveLock(fifoPath)).rejects.toThrow(/single-link regular file/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('delivers diagnostics to surviving leases and keeps ownership on stop failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-subscribers-'))
    const dbPath = join(root, 'msgvault.db')
    const executable = join(root, 'fake-msgvault')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE sources(id INTEGER PRIMARY KEY,source_type TEXT NOT NULL,identifier TEXT NOT NULL)`)
    db.close()
    writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o700)
    const clock = new FakeClock()
    const common = {
      discoverAccounts: async () => ['a@test'],
      syncAccount: async () => { throw new Error('synthetic failure') },
      now: () => clock.now,
      random: () => 0.5,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }
    const firstErrors: string[] = [], secondErrors: string[] = []
    const first = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable }, {
      ...common, onError: (message) => firstErrors.push(message),
    })
    const second = await acquireMsgvaultSyncRuntime({ enabled: true, dbPath, executable }, {
      ...common, onError: (message) => secondErrors.push(message),
    })
    expect(first.supervisor).toBe(second.supervisor)
    await first.release()
    await clock.advance(0); await flush()
    expect(firstErrors).toEqual([])
    expect(secondErrors).toEqual(['synthetic failure'])
    await second.release()

    let released = 0
    class StopFailureSupervisor extends MsgvaultSyncSupervisor {
      override stop(): Promise<void> { return Promise.reject(new Error('drain failed')) }
    }
    const deps: MsgvaultSyncSupervisorDependencies = {
      discoverAccounts: async () => [], syncAccount: async () => ({ changed: true }),
      now: () => 0, random: () => 0.5, setTimeout: () => 1, clearTimeout: () => undefined,
    }
    const key = `stop-failure-${Date.now()}-${Math.random()}`
    const lease = await acquireSyncSupervisorSingleton(key, () => new StopFailureSupervisor(deps), {
      acquireOwnership: async () => ({
        holderPid: -1, holderClosed: Promise.resolve(), databasePath: () => '',
        spawnContext: () => ({ home: '', inheritedFds: [0, 0] }),
        release: async () => { released++ },
      }),
    })
    await expect(lease.release()).rejects.toThrow(/drain failed/)
    expect(released).toBe(0)
    await expect(acquireSyncSupervisorSingleton(key, () => new StopFailureSupervisor(deps))).rejects.toThrow(/drain failed/)
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
