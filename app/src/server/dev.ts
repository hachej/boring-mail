import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWorkspaceAgentServer } from '@hachej/boring-workspace/app/server'
import type { BridgeAuthPolicy } from '@hachej/boring-workspace/server'
import createBoringMailServerPlugin from '../../../boring-mail/src/boring-ui/server.ts'
import type { StandaloneDeploymentConfig } from './standaloneHostAuth.ts'

export const AGENT_API_PORT = Number(process.env.AGENT_API_PORT) || 5290
export const VITE_PORT = Number(process.env.PORT) || 5190
export const APP_ROOT = resolve(import.meta.dirname, '../..')
export const PLAYGROUND_WORKSPACE_ROOT = resolve(APP_ROOT, process.env.BORING_MAIL_PLAYGROUND_ROOT || '.playground')

interface StartBoringMailPlaygroundServerOptions {
  browserAuthPolicy: BridgeAuthPolicy
  deployment: StandaloneDeploymentConfig
}

export interface BoringMailPlaygroundServerHandle {
  close(): Promise<void>
}

type WorkspaceAgentServer = Awaited<ReturnType<typeof createWorkspaceAgentServer>>

interface BackendIdentity {
  browserAuthPolicy: BridgeAuthPolicy
  deployment: StandaloneDeploymentConfig
}

interface BackendGeneration {
  generation: number
  identity: BackendIdentity
  app: WorkspaceAgentServer
  closePromise: Promise<void> | null
}

interface BackendStartRequest {
  identity: BackendIdentity
  options: StartBoringMailPlaygroundServerOptions
  promise: Promise<BoringMailPlaygroundServerHandle>
  resolve(handle: BoringMailPlaygroundServerHandle): void
  reject(error: unknown): void
}

interface BackendRegistry {
  active: BackendGeneration | null
  current: BackendStartRequest | null
  queue: BackendStartRequest[]
  draining: boolean
  nextGeneration: number
  processShutdownInstalled: boolean
}

const REGISTRY_SYMBOL = Symbol.for('@hachej/boring-mail/playground-backend.v1')
const root = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: BackendRegistry }
const registry = root[REGISTRY_SYMBOL] ??= {
  active: null,
  current: null,
  queue: [],
  draining: false,
  nextGeneration: 1,
  processShutdownInstalled: false,
}

function seedPlaygroundWorkspace(workspaceRoot = PLAYGROUND_WORKSPACE_ROOT): void {
  mkdirSync(resolve(workspaceRoot, 'drafts'), { recursive: true })
  mkdirSync(resolve(workspaceRoot, 'sent'), { recursive: true })

  const readmePath = resolve(workspaceRoot, 'README.md')
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, '# Boring Mail playground\n\nRuntime files for the mail playground live here. This directory is gitignored.\n', 'utf8')
  }

  const draftPath = resolve(workspaceRoot, 'drafts/new.mail.md')
  if (!existsSync(draftPath)) {
    writeFileSync(draftPath, [
      '---',
      'to: ',
      'cc: ',
      'subject: ',
      'kind: boring-mail-draft',
      '---',
      '',
      '',
    ].join('\n'), 'utf8')
  }
}

function sameIdentity(left: BackendIdentity, right: BackendIdentity): boolean {
  return left.browserAuthPolicy === right.browserAuthPolicy && left.deployment === right.deployment
}

function closeGeneration(entry: BackendGeneration): Promise<void> {
  if (!entry.closePromise) {
    entry.closePromise = entry.app.close()
      .catch(() => undefined)
      .finally(() => {
        if (registry.active === entry) registry.active = null
      })
  }
  return entry.closePromise
}

function handleFor(entry: BackendGeneration): BoringMailPlaygroundServerHandle {
  return {
    close: () => closeGeneration(entry),
  }
}

function installProcessShutdown(): void {
  if (registry.processShutdownInstalled) return
  registry.processShutdownInstalled = true
  process.once('beforeExit', () => {
    const active = registry.active
    if (active) void closeGeneration(active)
  })
}

async function createBackendGeneration(options: StartBoringMailPlaygroundServerOptions, identity: BackendIdentity): Promise<BackendGeneration> {
  seedPlaygroundWorkspace(options.deployment.workspaceRoot)
  const localRuntimeMode = process.env.BORING_AGENT_MODE?.trim() === 'direct' ? 'direct' : 'local'
  console.log(`[boring-mail] playground workspace root: ${options.deployment.workspaceRoot}`)
  console.log(`[boring-mail] standalone deployment mode: ${options.deployment.mode}`)
  console.log(`[boring-mail] agent runtime mode: ${localRuntimeMode}`)
  console.log('[boring-mail] LLM/model provider config: default Pi host settings')

  let app: WorkspaceAgentServer | null = null
  try {
    app = await createWorkspaceAgentServer({
      workspaceRoot: options.deployment.workspaceRoot,
      appRoot: APP_ROOT,
      mode: localRuntimeMode,
      logger: true,
      externalPlugins: false,
      installPluginAuthoring: false,
      plugins: [createBoringMailServerPlugin({
        workspaceRoot: options.deployment.workspaceRoot,
        mode: options.deployment.mode,
        sync: options.deployment.sync,
        mailRuntime: options.deployment.mailRuntime,
      })],
      defaultPluginPackages: ['@hachej/boring-ask-user'],
      workspaceBridge: { browserAuthPolicy: options.browserAuthPolicy },
    })

    app.get('/api/v1/workspace/meta', async () => ({
      projectName: 'Boring Mail',
      workspaceId: options.deployment.workspaceId,
      workspaceRoot: options.deployment.workspaceRoot,
    }))

    // 0.1.103: session routes moved from /api/v1/agent/pi-chat/sessions to
    // /api/v1/agents/:agentTypeId/sessions (front default agentTypeId: "default").
    const existingSessions = await app.inject({ method: 'GET', url: '/api/v1/agents/default/sessions' })
    const sessions = existingSessions.statusCode === 200
      ? (JSON.parse(existingSessions.body) as { sessions?: unknown[] }).sessions ?? []
      : []
    if (sessions.length === 0) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/agents/default/sessions',
        payload: { title: 'Chief of Staff' },
      })
    }

    await app.listen({ port: AGENT_API_PORT, host: '127.0.0.1' })
    const entry: BackendGeneration = {
      generation: registry.nextGeneration++,
      identity,
      app,
      closePromise: null,
    }
    return entry
  } catch (error) {
    await app?.close().catch(() => undefined)
    throw error
  }
}

function makeStartRequest(options: StartBoringMailPlaygroundServerOptions, identity: BackendIdentity): BackendStartRequest {
  let resolve!: (handle: BoringMailPlaygroundServerHandle) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<BoringMailPlaygroundServerHandle>((requestResolve, requestReject) => {
    resolve = requestResolve
    reject = requestReject
  })
  return { identity, options, promise, resolve, reject }
}

async function drainStartQueue(): Promise<void> {
  if (registry.draining) return
  registry.draining = true
  try {
    while (registry.queue.length > 0) {
      const request = registry.queue.shift()!
      registry.current = request
      try {
        const active = registry.active
        if (active && sameIdentity(active.identity, request.identity)) {
          request.resolve(handleFor(active))
          continue
        }
        if (active) await closeGeneration(active)
        const entry = await createBackendGeneration(request.options, request.identity)
        registry.active = entry
        request.resolve(handleFor(entry))
      } catch (error) {
        request.reject(error)
      } finally {
        if (registry.current === request) registry.current = null
      }
    }
  } finally {
    registry.draining = false
    if (registry.queue.length > 0) void drainStartQueue()
  }
}

export async function startBoringMailPlaygroundServer(options: StartBoringMailPlaygroundServerOptions): Promise<BoringMailPlaygroundServerHandle> {
  installProcessShutdown()
  const identity: BackendIdentity = {
    browserAuthPolicy: options.browserAuthPolicy,
    deployment: options.deployment,
  }
  if (!registry.draining && registry.active && sameIdentity(registry.active.identity, identity)) {
    return handleFor(registry.active)
  }
  if (registry.current && sameIdentity(registry.current.identity, identity)) return registry.current.promise
  const queued = registry.queue.find((request) => sameIdentity(request.identity, identity))
  if (queued) return queued.promise

  const request = makeStartRequest(options, identity)
  registry.queue.push(request)
  void drainStartQueue()
  return request.promise
}
