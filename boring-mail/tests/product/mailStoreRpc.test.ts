// @vitest-environment node
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import * as publicStoreApi from '../../src/mail/store/productDb.js'
import type { DraftRecord } from '../../src/mail/store/productDb.js'
import {
  openMailStoreForTest,
  type MailStoreWorkerFactory,
  type WorkerTransport,
} from '../../src/mail/store/internalProductStore.js'

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
    expect(publicStoreApi).not.toHaveProperty('listUnifiedInbox')
  })
  it('shares one concurrent start by canonical DB path and closes on last reference', async () => {
    const created: Worker[] = [], db = path(), make = factory(created, { startupDelayMs: 20 })
    const [first, second] = await Promise.all([
      openMailStoreForTest({ productDbPath: db }, { workerFactory: make }),
      openMailStoreForTest({ productDbPath: join(db, '..', 'boring-mail.db') }, { workerFactory: make }),
    ])
    expect(created).toHaveLength(1)
    const result: DraftRecord | null = await first.getDraft('missing')
    expect(result).toBeNull()
    await expect(first.listUnifiedInbox({ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null })
    await first.close()
    await expect(first.getDraft('closed-reference')).rejects.toThrow(/reference is closed/)
    expect(await second.getDraft('still-alive')).toBeNull()
    await second.close()
    const reopened = await openMailStoreForTest({ productDbPath: db }, { workerFactory: make })
    expect(created).toHaveLength(2)
    await reopened.close()
  })

  it('evicts an unexpectedly exited worker so the data directory can reopen', async () => {
    const created: Worker[] = [], db = path(), make = factory(created)
    const crashed = await openMailStoreForTest({ productDbPath: db }, { workerFactory: make })
    await expect(crashed.getDraft('crash')).rejects.toThrow(/exited unexpectedly/)
    const reopened = await openMailStoreForTest({ productDbPath: db }, { workerFactory: make })
    expect(created).toHaveLength(2)
    await crashed.close()
    await reopened.close()
  })

  it('preserves typed ProductStore errors over structured clone', async () => {
    const store = await openMailStoreForTest({ productDbPath: path() }, { workerFactory: factory([]) })
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
    await expect(openMailStoreForTest({ productDbPath: db }, { workerFactory: failing })).rejects.toMatchObject({
      code: 'invalid_input', message: 'fixture startup failed',
    })
    const store = await openMailStoreForTest({ productDbPath: db }, { workerFactory: factory([]) })
    await store.close()
  })

  it('keeps a disposal tombstone so reopen waits for delayed last-close termination', async () => {
    const created: Worker[] = [], db = path(), make = factory(created, { closeDelayMs: 50 })
    const store = await openMailStoreForTest({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 500,
    })
    const closing = store.close()
    const reopening = openMailStoreForTest({ productDbPath: db }, {
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
    await expect(openMailStoreForTest({ productDbPath: db }, {
      workerFactory: silent, startupTimeoutMs: 20,
    })).rejects.toMatchObject({ code: 'rpc_timeout' })
    const healthy = await openMailStoreForTest({ productDbPath: db }, { workerFactory: factory([]) })
    await healthy.close()
  })

  it('request timeout fail-stops all pending calls and permits reopen after disposal', async () => {
    const db = path(), make = factory([])
    const store = await openMailStoreForTest({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 20,
    })
    const first = store.getDraft('hang'), second = store.getDraft('hang')
    await expect(first).rejects.toMatchObject({ code: 'rpc_timeout' })
    await expect(second).rejects.toMatchObject({ code: 'rpc_timeout' })
    const reopened = await openMailStoreForTest({ productDbPath: db }, {
      workerFactory: factory([]), requestTimeoutMs: 100,
    })
    await store.close()
    await reopened.close()
  })

  it('bounds pending requests without killing the healthy worker', async () => {
    const db = path(), make = factory([], { responseDelayMs: 30 })
    const store = await openMailStoreForTest({ productDbPath: db }, {
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
    await expect(openMailStoreForTest({ productDbPath: db }, {
      workerFactory: make, startupTimeoutMs: 0,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    const store = await openMailStoreForTest({ productDbPath: db }, {
      workerFactory: make, requestTimeoutMs: 100,
    })
    try {
      await expect(openMailStoreForTest({ productDbPath: db }, {
        workerFactory: make, requestTimeoutMs: 101,
      })).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      await store.close()
    }
  })

  it('rejects a dangling final symlink instead of treating it as an absent database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mail-dangling-')),
      alias = join(root, 'dangling.db')
    symlinkSync(join(root, 'missing-target.db'), alias)
    await expect(openMailStoreForTest({ productDbPath: alias }, { workerFactory: factory([]) }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refuses to reuse a path whose open directory inode was replaced', async () => {
    const db = path(), directory = dirname(db), moved = `${directory}.moved`, make = factory([])
    const store = await openMailStoreForTest({ productDbPath: db }, { workerFactory: make })
    renameSync(directory, moved)
    mkdirSync(directory)
    try {
      await expect(openMailStoreForTest({ productDbPath: db }, { workerFactory: make }))
        .rejects.toThrow(/path identity changed/)
    } finally {
      await store.close()
      rmSync(directory, { recursive: true, force: true })
      renameSync(moved, directory)
    }
  })

  it('canonicalizes symlink aliases to one database/worker and rejects hardlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mail-alias-')),
      targetDir = join(root, 'target'), aliasA = join(root, 'alias-a'), aliasB = join(root, 'alias-b')
    mkdirSync(targetDir); mkdirSync(aliasA); mkdirSync(aliasB)
    const target = join(targetDir, 'boring-mail.db')
    writeFileSync(target, '')
    symlinkSync(target, join(aliasA, 'db'))
    symlinkSync(target, join(aliasB, 'db'))
    const created: Worker[] = [], make = factory(created)
    const [a, b] = await Promise.all([
      openMailStoreForTest({ productDbPath: join(aliasA, 'db') }, { workerFactory: make }),
      openMailStoreForTest({ productDbPath: join(aliasB, 'db') }, { workerFactory: make }),
    ])
    expect(created).toHaveLength(1)
    await a.close(); await b.close()
    const hardlink = join(targetDir, 'hardlink.db')
    linkSync(target, hardlink)
    await expect(openMailStoreForTest({ productDbPath: hardlink }, { workerFactory: make }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects conflicting configuration within one canonical data directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mail-config-')),
      db = join(root, 'boring-mail.db'), vaultA = join(root, 'vault-a.db'), vaultB = join(root, 'vault-b.db'),
      make = factory([])
    writeFileSync(vaultA, ''); writeFileSync(vaultB, '')
    const store = await openMailStoreForTest({ productDbPath: db, msgvaultDbPath: vaultA }, { workerFactory: make })
    try {
      await expect(openMailStoreForTest(
        { productDbPath: db, msgvaultDbPath: vaultB }, { workerFactory: make },
      )).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(openMailStoreForTest(
        { productDbPath: join(root, 'other.db'), msgvaultDbPath: vaultA }, { workerFactory: make },
      )).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      await store.close()
    }
  })
})
