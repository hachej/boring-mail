// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAX_TIMER_DELAY_MS,
  MsgvaultSyncSupervisor,
  type MsgvaultSyncSupervisorDependencies,
} from '../src/mail/sync/msgvaultSyncSupervisor.js'
import { deferred, FakeClock, flush, harness } from './helpers/msgvaultSyncHarness.js'

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

  it('retries a failed heartbeat arm, discovers later accounts, and recovers failed account arms', async () => {
    const clock = new FakeClock()
    const accounts = ['a@test']
    const pending = deferred<{ changed: boolean }>()
    const calls: string[] = []
    const errors: string[] = []
    let heartbeatArms = 0
    let failNextAccountArm = false
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
        if (delay === 1_000 && failNextAccountArm) {
          failNextAccountArm = false
          throw new Error('later account arm failed')
        }
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

    failNextAccountArm = true
    accounts.push('c@test')
    await clock.advance(10); await flush()
    expect(calls.filter((account) => account === 'c@test')).toHaveLength(1)
    expect(supervisor.health().find((health) => health.account === 'c@test')).toMatchObject({ nextRunAt: null })
    await clock.advance(10); await flush()
    expect(calls.filter((account) => account === 'c@test')).toHaveLength(2)

    let stopped = false
    const stop = supervisor.stop().then(() => { stopped = true })
    await flush()
    expect(stopped).toBe(false)
    pending.resolve({ changed: true })
    await stop
    expect(errors).toContain('clear failed')
  })

  it('uses internal timer identity when external handles are null', async () => {
    const callbacks: Array<() => void> = []
    let clears = 0, discoveries = 0, calls = 0
    const supervisor = new MsgvaultSyncSupervisor({
      discoverAccounts: async () => { discoveries++; return ['a@test'] },
      syncAccount: async () => { calls++; return { changed: true } },
      now: () => 0,
      random: () => 0.5,
      setTimeout(callback) { callbacks.push(callback); return null },
      clearTimeout(handle) { expect(handle).toBeNull(); clears++ },
    }, { activeIntervalMs: 1_000, heartbeatMs: 10, suspendLateAfterMs: 1_000 })
    await supervisor.start()
    const initialAccount = callbacks[0]!
    const staleHeartbeat = callbacks[1]!
    initialAccount(); await flush()
    expect(calls).toBe(1)
    const staleAccount = callbacks[2]!
    await supervisor.syncNow('a@test')
    expect(calls).toBe(2)
    staleAccount(); await flush()
    expect(calls).toBe(2)
    await supervisor.stop()
    const discoveriesAtStop = discoveries
    staleHeartbeat(); await flush()
    expect(discoveries).toBe(discoveriesAtStop)
    expect(clears).toBeGreaterThan(0)
  })

  it('rejects callbacks invoked synchronously while a timer is arming', async () => {
    const synchronous = (accounts: string[]) => new MsgvaultSyncSupervisor({
      discoverAccounts: async () => accounts,
      syncAccount: async () => ({ changed: true }),
      now: () => 0,
      random: () => 0.5,
      setTimeout(callback) { callback(); return null },
      clearTimeout: () => undefined,
    })
    const accountTimer = synchronous(['a@test'])
    await expect(accountTimer.start()).rejects.toThrow(/must run asynchronously/)
    expect(accountTimer.health()[0]).toMatchObject({ nextRunAt: null, inFlight: false })
    await accountTimer.stop()
    const heartbeatTimer = synchronous([])
    await expect(heartbeatTimer.start()).rejects.toThrow(/must run asynchronously/)
    await heartbeatTimer.stop()
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
