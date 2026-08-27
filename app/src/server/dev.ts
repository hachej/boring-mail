import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWorkspaceAgentServer } from '@hachej/boring-workspace/app/server'
import createBoringMailServerPlugin from '@hachej/boring-mail/server'

export const AGENT_API_PORT = Number(process.env.AGENT_API_PORT) || 5290
export const VITE_PORT = Number(process.env.PORT) || 5190
export const APP_ROOT = resolve(import.meta.dirname, '../..')
export const PLAYGROUND_WORKSPACE_ROOT = resolve(APP_ROOT, process.env.BORING_MAIL_PLAYGROUND_ROOT || '.playground')

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

let boot: Promise<void> | null = null

export async function startBoringMailPlaygroundServer(): Promise<void> {
  if (boot) return boot
  const attempt = (async () => {
    seedPlaygroundWorkspace()
    const localRuntimeMode = process.env.BORING_AGENT_MODE?.trim() === 'direct' ? 'direct' : 'local'
    console.log(`[boring-mail] playground workspace root: ${PLAYGROUND_WORKSPACE_ROOT}`)
    console.log(`[boring-mail] agent runtime mode: ${localRuntimeMode}`)
    console.log('[boring-mail] LLM/model provider config: default Pi host settings')

    let app: Awaited<ReturnType<typeof createWorkspaceAgentServer>> | null = null
    try {
      app = await createWorkspaceAgentServer({
        workspaceRoot: PLAYGROUND_WORKSPACE_ROOT,
        appRoot: APP_ROOT,
        mode: localRuntimeMode,
        logger: true,
        externalPlugins: false,
        installPluginAuthoring: false,
        plugins: [createBoringMailServerPlugin({ workspaceRoot: PLAYGROUND_WORKSPACE_ROOT })],
        defaultPluginPackages: ['@hachej/boring-ask-user'],
        workspaceBridge: { allowInsecureLocalCliBrowserAuth: true },
      })

      app.get('/api/v1/workspace/meta', async () => ({
        projectName: 'Boring Mail',
        workspaceId: 'boring-mail-playground',
        workspaceRoot: PLAYGROUND_WORKSPACE_ROOT,
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
    } catch (error) {
      await app?.close().catch(() => undefined)
      throw error
    }
  })()
  boot = attempt
  try {
    await attempt
  } catch (error) {
    if (boot === attempt) boot = null
    throw error
  }
}
