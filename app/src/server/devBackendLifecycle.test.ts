// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoringMailPlaygroundServerHandle } from './dev.ts'

interface MockPolicy {
  proofLabel: string
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

const state = vi.hoisted(() => ({
  events: [] as string[],
  nextId: 1,
  failListenLabels: new Set<string>(),
  listenPauses: new Map<string, Deferred>(),
}))

vi.mock('@hachej/boring-workspace/app/server', () => ({
  createWorkspaceAgentServer: vi.fn(async (options: { workspaceBridge: { browserAuthPolicy: MockPolicy } }) => {
    const id = state.nextId++
    const label = options.workspaceBridge.browserAuthPolicy.proofLabel
    state.events.push(`create:${id}:${label}`)
    return {
      get: vi.fn(),
      inject: vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ sessions: [{}] }) })),
      listen: vi.fn(async () => {
        state.events.push(`listen:start:${id}:${label}`)
        const pause = state.listenPauses.get(label)
        if (pause) await pause.promise
        state.events.push(`listen:${id}:${label}`)
        if (state.failListenLabels.delete(label)) throw new Error(`listen failed:${label}`)
      }),
      close: vi.fn(async () => { state.events.push(`close:${id}:${label}`) }),
    }
  }),
}))

const roots: string[] = []
const handles: BoringMailPlaygroundServerHandle[] = []
let moduleNonce = 0

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  state.events = []
  state.nextId = 1
  state.failListenLabels.clear()
  state.listenPauses.clear()
})

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((promiseResolve) => { resolve = promiseResolve })
  return { promise, resolve }
}

function pauseListen(label: string): Deferred {
  const pause = deferred()
  state.listenPauses.set(label, pause)
  return pause
}

async function waitForEvent(event: string): Promise<void> {
  await vi.waitFor(() => expect(state.events).toContain(event))
}

async function loadDevInstance(): Promise<typeof import('./dev.ts')> {
  return await import(/* @vite-ignore */ `./dev.ts?backend-lifecycle=${moduleNonce++}`)
}

function policy(proofLabel: string): MockPolicy {
  return { proofLabel }
}

function deployment(root = mkdtempSync(join(tmpdir(), 'bm-dev-backend-'))) {
  roots.push(root)
  return {
    mode: 'fixture' as const,
    tokenFile: join(root, 'token'),
    bindHost: '127.0.0.1',
    hmrHost: '127.0.0.1',
    allowedOrigin: 'http://127.0.0.1:5190',
    backendOrigin: 'http://127.0.0.1:5290',
    trustTailnetHttp: false,
    workspaceId: 'default' as const,
    workspaceRoot: root,
    sync: false as const,
    mailRuntime: {
      productDbPath: join(root, '.boring-mail', 'fixture', 'product', 'mail.db'),
      msgvaultDbPath: join(root, '.boring-mail', 'fixture', 'msgvault', 'msgvault.db'),
    },
  }
}

async function start(label: string): Promise<BoringMailPlaygroundServerHandle> {
  const mod = await loadDevInstance()
  const handle = await mod.startBoringMailPlaygroundServer({
    browserAuthPolicy: policy(label) as never,
    deployment: deployment(),
  })
  handles.push(handle)
  return handle
}

describe('startBoringMailPlaygroundServer lifecycle', () => {
  it('coalesces only exact in-flight identity and serializes a distinct replacement from another module instance', async () => {
    const firstModule = await loadDevInstance()
    const secondModule = await loadDevInstance()
    const firstPolicy = policy('proof-a')
    const firstDeployment = deployment()
    const replacementPolicy = policy('proof-b')
    const replacementDeployment = deployment()
    const firstPause = pauseListen('proof-a')

    const firstStart = firstModule.startBoringMailPlaygroundServer({
      browserAuthPolicy: firstPolicy as never,
      deployment: firstDeployment,
    })
    await waitForEvent('listen:start:1:proof-a')

    const sameIdentityStart = secondModule.startBoringMailPlaygroundServer({
      browserAuthPolicy: firstPolicy as never,
      deployment: firstDeployment,
    })
    const replacementStart = secondModule.startBoringMailPlaygroundServer({
      browserAuthPolicy: replacementPolicy as never,
      deployment: replacementDeployment,
    })

    expect(state.events).toEqual(['create:1:proof-a', 'listen:start:1:proof-a'])
    firstPause.resolve()

    const [first, sameIdentity, replacement] = await Promise.all([firstStart, sameIdentityStart, replacementStart])
    handles.push(first, sameIdentity, replacement)

    expect(first).toBe(sameIdentity)
    expect(replacement).not.toBe(first)
    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
    ])

    await first.close()
    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
    ])
    await Promise.all([replacement.close(), replacement.close()])
    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
      'close:2:proof-b',
    ])
  }, 15_000)

  it('serializes multiple distinct overlapping generations and keeps late closes generation-local', async () => {
    const first = await start('proof-a')
    expect(state.events).toEqual(['create:1:proof-a', 'listen:start:1:proof-a', 'listen:1:proof-a'])

    const secondPause = pauseListen('proof-b')
    const secondModule = await loadDevInstance()
    const thirdModule = await loadDevInstance()
    const secondStart = secondModule.startBoringMailPlaygroundServer({
      browserAuthPolicy: policy('proof-b') as never,
      deployment: deployment(),
    })
    await waitForEvent('listen:start:2:proof-b')
    const thirdStart = thirdModule.startBoringMailPlaygroundServer({
      browserAuthPolicy: policy('proof-c') as never,
      deployment: deployment(),
    })

    secondPause.resolve()
    const [second, third] = await Promise.all([secondStart, thirdStart])
    handles.push(second, third)

    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
      'close:2:proof-b',
      'create:3:proof-c',
      'listen:start:3:proof-c',
      'listen:3:proof-c',
    ])

    await Promise.all([first.close(), second.close()])
    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
      'close:2:proof-b',
      'create:3:proof-c',
      'listen:start:3:proof-c',
      'listen:3:proof-c',
    ])
    await Promise.all([third.close(), third.close()])
    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
      'close:2:proof-b',
      'create:3:proof-c',
      'listen:start:3:proof-c',
      'listen:3:proof-c',
      'close:3:proof-c',
    ])
  }, 15_000)

  it('failed intermediate replacement does not poison the latest queued generation', async () => {
    const first = await start('proof-a')
    const failingPause = pauseListen('proof-b')
    state.failListenLabels.add('proof-b')

    const secondModule = await loadDevInstance()
    const thirdModule = await loadDevInstance()
    const failingStart = secondModule.startBoringMailPlaygroundServer({
      browserAuthPolicy: policy('proof-b') as never,
      deployment: deployment(),
    })
    await waitForEvent('listen:start:2:proof-b')
    const latestStart = thirdModule.startBoringMailPlaygroundServer({
      browserAuthPolicy: policy('proof-c') as never,
      deployment: deployment(),
    })

    failingPause.resolve()
    await expect(failingStart).rejects.toThrow(/listen failed:proof-b/)
    const latest = await latestStart
    handles.push(latest)

    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
      'close:2:proof-b',
      'create:3:proof-c',
      'listen:start:3:proof-c',
      'listen:3:proof-c',
    ])

    await first.close()
    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
      'close:2:proof-b',
      'create:3:proof-c',
      'listen:start:3:proof-c',
      'listen:3:proof-c',
    ])
    await latest.close()
    expect(state.events).toEqual([
      'create:1:proof-a',
      'listen:start:1:proof-a',
      'listen:1:proof-a',
      'close:1:proof-a',
      'create:2:proof-b',
      'listen:start:2:proof-b',
      'listen:2:proof-b',
      'close:2:proof-b',
      'create:3:proof-c',
      'listen:start:3:proof-c',
      'listen:3:proof-c',
      'close:3:proof-c',
    ])
  }, 15_000)
})
