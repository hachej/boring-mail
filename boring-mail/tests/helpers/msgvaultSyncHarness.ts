import {
  MsgvaultSyncSupervisor,
  type MsgvaultSyncSupervisorDependencies,
  type MsgvaultSyncSupervisorOptions,
} from '../../src/mail/sync/msgvaultSyncSupervisor.js'

export const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

export class FakeClock {
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

export function harness(
  accounts: string[],
  syncAccount: MsgvaultSyncSupervisorDependencies['syncAccount'],
  random = () => 0.5,
  options: MsgvaultSyncSupervisorOptions = {},
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

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function captureError(promise: Promise<unknown>): Promise<Error> {
  try { await promise } catch (error) { return error as Error }
  throw new Error('expected promise to reject')
}
