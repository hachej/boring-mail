// @vitest-environment node
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import createBoringMailServerPlugin from '../server.ts'

function fakeFastify() {
  const posts: string[] = []
  const hooks: string[] = []
  return {
    posts,
    hooks,
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
    post(path: string) { posts.push(path) },
    addHook(name: string) { hooks.push(name) },
  }
}

function isContained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && rel !== ''
}

function writeFixtureArchive(path: string, identity: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE sources(id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, identifier TEXT NOT NULL);
      CREATE TABLE account_identities(source_id INTEGER NOT NULL, address TEXT NOT NULL, source_signal TEXT NOT NULL DEFAULT '', confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_id,address));
      INSERT INTO sources(id, source_type, identifier) VALUES(1, 'gmail', '${identity}');
      INSERT INTO account_identities(source_id, address) VALUES(1, '${identity}');
    `)
  } finally {
    db.close()
  }
}

describe('Boring Mail server plugin mode wiring', () => {
  it('registers fixture bridge handlers, keeps draft route, and missing fixture DB is typed-unavailable without boot failure', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'bm-plugin-'))
    const openStore = vi.fn()
    const plugin = createBoringMailServerPlugin({
      workspaceRoot,
      mode: 'fixture',
      mailRuntime: {
        acquireSync: async (options) => {
          expect(options).toBe(false)
          return { supervisor: null, release: async () => undefined }
        },
        openStore,
      },
    })
    expect(plugin.contentDigest).toBe('boring-mail-server-plugin-v4-fixture')
    expect(plugin.workspaceBridgeHandlers?.map((handler) => handler.definition.op)).toEqual(['boring-mail.v1.inbox.list', 'boring-mail.v1.thread.get'])
    expect(plugin.systemPrompt).toContain('fixture mail')
    const app = fakeFastify()
    await plugin.routes?.(app as never, undefined as never)
    expect(app.posts).toEqual(['/api/boring-mail/drafts'])
    expect(openStore).not.toHaveBeenCalled()
    const output = await plugin.workspaceBridgeHandlers![0].handler({ input: {}, context: {} as never, definition: plugin.workspaceBridgeHandlers![0].definition, signal: new AbortController().signal })
    expect(output).toEqual({ status: 'unavailable' })
  })

  it('rejects fixture runtime path/home overrides and symlink escapes', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'bm-plugin-'))
    expect(() => createBoringMailServerPlugin({
      workspaceRoot,
      mode: 'fixture',
      mailRuntime: { productDbPath: join(workspaceRoot, 'other.db') },
    })).toThrow(/product path override/)
    expect(() => createBoringMailServerPlugin({
      workspaceRoot,
      mode: 'fixture',
      mailRuntime: { msgvaultHome: workspaceRoot },
    })).toThrow(/home override/)
    await mkdir(join(workspaceRoot, '.boring-mail', 'fixture'), { recursive: true })
    await symlink(tmpdir(), join(workspaceRoot, '.boring-mail', 'fixture', 'msgvault'))
    expect(() => createBoringMailServerPlugin({ workspaceRoot, mode: 'fixture' })).toThrow(/symlink msgvault parent/)
  })

  it('rejects symlink fixture workspace root', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'bm-plugin-'))
    const link = join(tmpdir(), `bm-plugin-link-${Date.now()}`)
    await symlink(workspaceRoot, link)
    expect(() => createBoringMailServerPlugin({ workspaceRoot: link, mode: 'fixture' })).toThrow(/symlink workspace root/)
  })

  it('keeps copied live-looking fixture archives unavailable without opening the store', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'bm-plugin-'))
    const msgvaultDbPath = join(workspaceRoot, '.boring-mail', 'fixture', 'msgvault', 'msgvault.db')
    await mkdir(join(workspaceRoot, '.boring-mail', 'fixture', 'msgvault'), { recursive: true })
    writeFixtureArchive(msgvaultDbPath, 'owner@gmail.com')
    const openStore = vi.fn()
    const plugin = createBoringMailServerPlugin({
      workspaceRoot,
      mode: 'fixture',
      mailRuntime: { acquireSync: async () => ({ supervisor: null, release: async () => undefined }), openStore },
    })
    await plugin.routes?.(fakeFastify() as never, undefined as never)
    const output = await plugin.workspaceBridgeHandlers![0].handler({ input: {}, context: {} as never, definition: plugin.workspaceBridgeHandlers![0].definition, signal: new AbortController().signal })
    expect(output).toEqual({ status: 'unavailable' })
    expect(openStore).not.toHaveBeenCalled()
  })

  it('derives canonical temp-contained fixture store paths when fixture DB exists', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'bm-plugin-'))
    const msgvaultDbPath = join(workspaceRoot, '.boring-mail', 'fixture', 'msgvault', 'msgvault.db')
    await mkdir(join(workspaceRoot, '.boring-mail', 'fixture', 'msgvault'), { recursive: true })
    writeFixtureArchive(msgvaultDbPath, 'owner@example.invalid')
    const seen: string[] = []
    const plugin = createBoringMailServerPlugin({
      workspaceRoot,
      mode: 'fixture',
      mailRuntime: {
        acquireSync: async () => ({ supervisor: null, release: async () => undefined }),
        openStore: async (config) => {
          seen.push(config.productDbPath, config.msgvaultDbPath ?? '')
          return {
            outbox: {} as never,
            upsertAccount: async () => undefined,
            saveDraft: async () => { throw new Error('unused') },
            getDraft: async () => null,
            reconcileMsgvaultReadSources: async () => ({ inserted: 0, updated: 0, vanished: 0, generation: 'g' }),
            setReadSourceEnabled: async () => undefined,
            listUnifiedInbox: async () => ({ items: [], nextCursor: null }),
            getUnifiedThread: async () => null,
            close: async () => undefined,
          }
        },
      },
    })
    await plugin.routes?.(fakeFastify() as never, undefined as never)
    expect(seen[0]).toBe(join(workspaceRoot, '.boring-mail', 'fixture', 'product', 'mail.db'))
    expect(seen[1]).toBe(msgvaultDbPath)
    expect(isContained(workspaceRoot, seen[0])).toBe(true)
    expect(isContained(workspaceRoot, seen[1])).toBe(true)
  })

  it('wires live mode bridge handlers and suppresses the draft route', async () => {
    const events: string[] = []
    const plugin = createBoringMailServerPlugin({
      workspaceRoot: await mkdtemp(join(tmpdir(), 'bm-plugin-')),
      mode: 'live',
      sync: false,
      mailRuntime: {
        productDbPath: join(await mkdtemp(join(tmpdir(), 'bm-plugin-db-')), 'mail.db'),
        msgvaultDbPath: '/tmp/msgvault.db',
        acquireSync: async () => ({ supervisor: null, release: async () => { events.push('sync:release') } }),
        openStore: async () => ({
          outbox: {} as never,
          upsertAccount: async () => undefined,
          saveDraft: async () => { throw new Error('unused') },
          getDraft: async () => null,
          reconcileMsgvaultReadSources: async () => ({ inserted: 0, updated: 0, vanished: 0, generation: 'g' }),
          setReadSourceEnabled: async () => undefined,
          listUnifiedInbox: async () => ({ items: [], nextCursor: null }),
          getUnifiedThread: async () => null,
          close: async () => { events.push('store:close') },
        }),
      },
    })
    expect(plugin.contentDigest).toBe('boring-mail-server-plugin-v4-live')
    expect(plugin.workspaceBridgeHandlers?.map((handler) => handler.definition.op)).toEqual(['boring-mail.v1.inbox.list', 'boring-mail.v1.thread.get'])
    expect(plugin.systemPrompt).toContain('not visible in the browser until Slice 5')
    const app = fakeFastify()
    await plugin.routes?.(app as never, undefined as never)
    expect(app.posts).toEqual([])
    expect(app.hooks).toEqual(['onClose'])
  })
})
