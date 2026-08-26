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
const factory = (created: Worker[]): MailStoreWorkerFactory => () => {
  const worker = new Worker(fixture)
  created.push(worker)
  return worker as WorkerTransport
}

describe('async MailStore worker RPC facade', () => {
  it('does not expose the synchronous worker implementation publicly', () => {
    expect(publicStoreApi).not.toHaveProperty('ProductStore')
    expect(publicStoreApi).not.toHaveProperty('openProductStore')
  })
  it('shares one real worker by canonical DB path and closes on last reference', async () => {
    const created: Worker[] = [], db = path(), make = factory(created)
    const first = await openMailStore({ productDbPath: db }, { workerFactory: make })
    const second = await openMailStore({ productDbPath: join(db, '..', 'boring-mail.db') }, { workerFactory: make })
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
