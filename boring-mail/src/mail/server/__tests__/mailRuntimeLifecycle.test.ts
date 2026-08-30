// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MailRuntimeLifecycleManager } from '../mailRuntimeLifecycle.ts'
import { ProductStoreError, type UnifiedInboxPage } from '../../store/product/types.ts'
import type { MailStore } from '../../store/product/MailStore.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'boring-mail-runtime-'))
  roots.push(root)
  return join(root, 'product', 'mail.db')
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 500; index++) {
    if (predicate()) return
    await tick()
  }
}

function syncLease(releases: string[], name: string) {
  return { supervisor: null, release: async () => { releases.push(name) } }
}

function store(name: string, events: string[], list: () => Promise<UnifiedInboxPage> = async () => ({ items: [], nextCursor: null })): MailStore {
  return {
    outbox: {} as MailStore['outbox'],
    upsertAccount: async () => undefined,
    saveDraft: async () => { throw new Error('unused') },
    getDraft: async () => null,
    reconcileMsgvaultReadSources: async () => { events.push(`${name}:reconcile`); return { inserted: 0, updated: 0, vanished: 0, generation: 'g' } },
    setReadSourceEnabled: async () => undefined,
    listUnifiedInbox: list,
    getUnifiedThread: async () => null,
    close: async () => { events.push(`${name}:close`) },
  }
}

describe('MailRuntimeLifecycleManager', () => {
  it('rolls back startup acquisition in reverse order when opening the store fails', async () => {
    const events: string[] = []
    const manager = new MailRuntimeLifecycleManager({
      productDbPath: await tempDbPath(),
      msgvaultDbPath: '/tmp/msgvault.db',
      sync: false,
      acquireSync: async () => syncLease(events, 'sync:release'),
      openStore: async () => { throw new Error('open failed') },
    })
    await expect(manager.start()).rejects.toThrow(/open failed/)
    expect(events).toEqual(['sync:release'])
  })

  it('returns unavailable on fatal read, tombstones the facade, and reopens one background generation', async () => {
    const events: string[] = []
    let opens = 0
    const manager = new MailRuntimeLifecycleManager({
      productDbPath: await tempDbPath(),
      msgvaultDbPath: '/tmp/msgvault.db',
      sync: false,
      acquireSync: async () => syncLease(events, `sync${opens}:release`),
      openStore: async () => {
        opens++
        if (opens === 1) {
          return store('store1', events, async () => { throw new ProductStoreError('rpc_timeout', 'timed out') })
        }
        return store('store2', events, async () => ({ items: [], nextCursor: null }))
      },
    })

    await manager.start()
    await expect(manager.read((s) => s.listUnifiedInbox())).resolves.toEqual({ status: 'unavailable' })
    expect(manager.recoveryPending).toBe(true)
    await expect(manager.read((s) => s.listUnifiedInbox())).resolves.toEqual({ status: 'unavailable' })
    await waitFor(() => opens === 2 && !manager.recoveryPending)
    await expect(manager.read((s) => s.listUnifiedInbox())).resolves.toMatchObject({ status: 'ok' })
    expect(opens).toBe(2)
    expect(events).toContain('store1:close')
    expect(events).toContain('store2:reconcile')
    expect(events).not.toContain('sync1:release')
  })

  it('does not recover for overloaded or expected storage/schema errors and rethrows unknown errors', async () => {
    const events: string[] = []
    let opens = 0
    const errors = [
      new ProductStoreError('rpc_overloaded', 'busy'),
      new ProductStoreError('corrupt_data', 'bad'),
      new ProductStoreError('unsupported_schema', 'bad schema'),
      new Error('unknown failure'),
    ]
    const manager = new MailRuntimeLifecycleManager({
      productDbPath: await tempDbPath(),
      msgvaultDbPath: '/tmp/msgvault.db',
      sync: false,
      acquireSync: async () => syncLease(events, `sync${opens}:release`),
      openStore: async () => {
        opens++
        return store('store1', events, async () => { throw errors.shift()! })
      },
    })
    await manager.start()
    await expect(manager.read((s) => s.listUnifiedInbox())).resolves.toEqual({ status: 'unavailable' })
    await expect(manager.read((s) => s.listUnifiedInbox())).resolves.toEqual({ status: 'unavailable' })
    await expect(manager.read((s) => s.listUnifiedInbox())).resolves.toEqual({ status: 'unavailable' })
    await expect(manager.read((s) => s.listUnifiedInbox())).rejects.toThrow(/unknown failure/)
    expect(opens).toBe(1)
    expect(manager.recoveryPending).toBe(false)
  })

  it('returns unavailable when a read finishes after its generation was replaced', async () => {
    const events: string[] = []
    let opens = 0
    let finishFirst!: () => void
    const firstRead = new Promise<UnifiedInboxPage>((resolve) => { finishFirst = () => resolve({ items: [], nextCursor: null }) })
    const manager = new MailRuntimeLifecycleManager({
      productDbPath: await tempDbPath(),
      msgvaultDbPath: '/tmp/msgvault.db',
      sync: false,
      acquireSync: async () => syncLease(events, `sync${opens}:release`),
      openStore: async () => {
        opens++
        return store(`store${opens}`, events, opens === 1 ? () => firstRead : async () => ({ items: [], nextCursor: null }))
      },
    })
    await manager.start()
    const pending = manager.read((s) => s.listUnifiedInbox())
    await manager.read(async () => { throw new ProductStoreError('rpc_unavailable', 'dead') })
    finishFirst()
    await expect(pending).resolves.toEqual({ status: 'unavailable' })
  })

  it('coalesces concurrent retries while recovery is pending', async () => {
    const events: string[] = []
    let opens = 0
    let releaseDisposal!: () => void
    const disposal = new Promise<void>((resolve) => { releaseDisposal = resolve })
    const manager = new MailRuntimeLifecycleManager({
      productDbPath: await tempDbPath(),
      msgvaultDbPath: '/tmp/msgvault.db',
      sync: false,
      acquireSync: async () => syncLease(events, `sync${opens}:release`),
      openStore: async () => {
        opens++
        if (opens === 1) {
          return { ...store('store1', events, async () => { throw new ProductStoreError('rpc_timeout', 'timed out') }), close: async () => { events.push('store1:close'); await disposal } }
        }
        return store(`store${opens}`, events)
      },
    })

    await manager.start()
    await expect(manager.read((s) => s.listUnifiedInbox())).resolves.toEqual({ status: 'unavailable' })
    await Promise.all([
      manager.read((s) => s.listUnifiedInbox()),
      manager.read((s) => s.listUnifiedInbox()),
      manager.read((s) => s.listUnifiedInbox()),
    ])
    expect(opens).toBe(1)
    releaseDisposal()
    await waitFor(() => opens === 2)
    expect(opens).toBe(2)
  })

  it('blocks reopen after shutdown and attempts all active cleanup', async () => {
    const events: string[] = []
    let opens = 0
    let releaseDisposal!: () => void
    const disposal = new Promise<void>((resolve) => { releaseDisposal = resolve })
    const manager = new MailRuntimeLifecycleManager({
      productDbPath: await tempDbPath(),
      msgvaultDbPath: '/tmp/msgvault.db',
      sync: false,
      acquireSync: async () => syncLease(events, `sync${opens}:release`),
      openStore: async () => {
        opens++
        return { ...store('store1', events, async () => { throw new ProductStoreError('rpc_timeout', 'timed out') }), close: async () => { events.push('store1:close'); await disposal } }
      },
    })
    await manager.start()
    await manager.read((s) => s.listUnifiedInbox())
    const shutdown = manager.shutdown()
    releaseDisposal()
    await shutdown
    await Promise.resolve()
    expect(opens).toBe(1)
    expect(events).toContain('store1:close')
    expect(events).toContain('sync0:release')
  })
})
