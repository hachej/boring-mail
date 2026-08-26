// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import * as publicStoreApi from '../../src/mail/store/productDb.js'
import {
  openMailStore,
  type DraftRecord,
  type MailStoreWorkerFactory,
  type WorkerTransport,
} from '../../src/mail/store/productDb.js'

const fixture = new URL('../fixtures/mailStoreRpcWorker.mjs', import.meta.url)
const path = () => join(mkdtempSync(join(tmpdir(), 'mail-rpc-')), 'boring-mail.db')
const factory = (created: Worker[], workerData?: Record<string, unknown>): MailStoreWorkerFactory => () => {
  const worker = new Worker(fixture, { workerData })
  created.push(worker)
  return worker as WorkerTransport
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('async MailStore worker RPC facade', () => {
  it('does not expose the synchronous worker implementation publicly', () => {
    expect(publicStoreApi).not.toHaveProperty('ProductStore')
    expect(publicStoreApi).not.toHaveProperty('openProductStore')
  })
  it('shares one concurrent start by canonical DB path and closes on last reference', async () => {
    const created: Worker[] = [], db = path(), make = factory(created, { startupDelayMs: 20 })
    const [first, second] = await Promise.all([
      openMailStore({ productDbPath: db }, { workerFactory: make }),
      openMailStore({ productDbPath: join(db, '..', 'boring-mail.db') }, { workerFactory: make }),
    ])
    expect(created).toHaveLength(1)
    const result: DraftRecord | null = await first.getDraft('missing')
    expect(result).toBeNull()
    await first.close()
    await expect(first.getDraft('closed-reference')).rejects.toThrow(/reference is closed/)
    expect(await second.getDraft('still-alive')).toBeNull()
    await second.close()
    const reopened = await openMailStore({ productDbPath: db }, { workerFactory: make })
    expect(created).toHaveLength(2)
    await reopened.close()
  })

  it('evicts an unexpectedly exited worker so the data directory can reopen', async () => {
    const created: Worker[] = [], db = path(), make = factory(created)
    const crashed = await openMailStore({ productDbPath: db }, { workerFactory: make })
    await expect(crashed.getDraft('crash')).rejects.toThrow(/exited unexpectedly/)
    const reopened = await openMailStore({ productDbPath: db }, { workerFactory: make })
    expect(created).toHaveLength(2)
    await crashed.close()
    await reopened.close()
  })

  it('preserves typed ProductStore errors over structured clone', async () => {
    const store = await openMailStore({ productDbPath: path() }, { workerFactory: factory([]) })
    try {
      await expect(store.outbox.get('missing')).rejects.toMatchObject({
        name: 'ProductStoreError', code: 'not_found', message: 'fixture outbox missing',
      })
    } finally {
      await store.close()
    }
  })

  it('rejects startup errors and permits a clean subsequent open', async () => {
    const db = path()
    const failing: MailStoreWorkerFactory = () => new Worker(fixture, {
      workerData: { failStartup: true },
    }) as WorkerTransport
    await expect(openMailStore({ productDbPath: db }, { workerFactory: failing })).rejects.toMatchObject({
      code: 'invalid_input', message: 'fixture startup failed',
    })
    const store = await openMailStore({ productDbPath: db }, { workerFactory: factory([]) })
    await store.close()
  })

  it('keeps a disposal tombstone so reopen waits for delayed last-close termination', async () => {
    const created: Worker[] = [], db = path(), make = factory(created, { closeDelayMs: 50 })
    const store = await openMailStore({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 500,
    })
    const closing = store.close()
    const reopening = openMailStore({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 500,
    })
    await wait(10)
    expect(created).toHaveLength(1)
    await closing
    const reopened = await reopening
    expect(created).toHaveLength(2)
    await reopened.close()
  })

  it('times out silent startup, disposes it, and permits a clean reopen', async () => {
    const db = path(), silent = factory([], { silentStartup: true })
    await expect(openMailStore({ productDbPath: db }, {
      workerFactory: silent, startupTimeoutMs: 20,
    })).rejects.toMatchObject({ code: 'rpc_timeout' })
    const healthy = await openMailStore({ productDbPath: db }, { workerFactory: factory([]) })
    await healthy.close()
  })

  it('request timeout fail-stops all pending calls and permits reopen after disposal', async () => {
    const db = path(), make = factory([])
    const store = await openMailStore({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 20,
    })
    const first = store.getDraft('hang'), second = store.getDraft('hang')
    await expect(first).rejects.toMatchObject({ code: 'rpc_timeout' })
    await expect(second).rejects.toMatchObject({ code: 'rpc_timeout' })
    const reopened = await openMailStore({ productDbPath: db }, {
      workerFactory: factory([]), requestTimeoutMs: 100,
    })
    await store.close()
    await reopened.close()
  })

  it('bounds pending requests without killing the healthy worker', async () => {
    const db = path(), make = factory([], { responseDelayMs: 30 })
    const store = await openMailStore({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 500, maxPendingRequests: 1,
    })
    const first = store.getDraft('slow')
    await expect(store.getDraft('over-limit')).rejects.toMatchObject({ code: 'rpc_overloaded' })
    await expect(first).resolves.toBeNull()
    await expect(store.getDraft('healthy')).resolves.toBeNull()
    await store.close()
  })

  it('validates RPC settings and rejects incompatible settings for a shared directory', async () => {
    const db = path(), make = factory([])
    await expect(openMailStore({ productDbPath: db }, {
      workerFactory: make, startupTimeoutMs: 0,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    const store = await openMailStore({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 100,
    })
    try {
      await expect(openMailStore({ productDbPath: db }, {
        workerFactory: make, requestTimeoutMs: 101,
      })).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      await store.close()
    }
  })

  it('rejects conflicting configuration within one canonical data directory', async () => {
    const db = path(), make = factory([])
    const store = await openMailStore({ productDbPath: db, msgvaultDbPath: '/vault/a' }, { workerFactory: make })
    try {
      await expect(openMailStore(
        { productDbPath: db, msgvaultDbPath: '/vault/b' }, { workerFactory: make },
      )).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(openMailStore(
        { productDbPath: join(db, '..', 'other.db'), msgvaultDbPath: '/vault/a' }, { workerFactory: make },
      )).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      await store.close()
    }
  })
})
