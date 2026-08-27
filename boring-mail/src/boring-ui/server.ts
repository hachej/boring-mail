import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { defineServerPlugin, type WorkspaceServerPlugin } from '@hachej/boring-workspace/server'
import { createMailAgentTool, serializeMailDraft } from '../mail/server/mailAgentTool.ts'
import {
  acquireMsgvaultSyncRuntime,
  type MsgvaultSyncRuntimeOptions,
} from '../mail/sync/msgvaultSyncRuntime.ts'

export { createBoringMailServer } from '../server/index.ts'
export { createMailAgentTool } from '../mail/server/mailAgentTool.ts'

export interface BoringMailServerPluginOptions {
  workspaceRoot?: string
  /** false disables sync; omission auto-enables when a msgvault database exists. */
  sync?: MsgvaultSyncRuntimeOptions | false
}

export default function createBoringMailServerPlugin(
  options: BoringMailServerPluginOptions = {},
  ctx?: { workspaceRoot?: string },
): WorkspaceServerPlugin {
  const workspaceRoot = options.workspaceRoot ?? ctx?.workspaceRoot ?? process.cwd()
  const safeWorkspacePath = (requested: string) => {
    const safe = normalize(requested).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '')
    const target = join(workspaceRoot, safe)
    const rel = relative(workspaceRoot, target)
    if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) throw new Error('path escapes workspace')
    if (!safe.endsWith('.mail.md')) throw new Error('mail draft path must end with .mail.md')
    return { path: safe.replace(/\\/g, '/'), target }
  }

  return defineServerPlugin({
    id: 'boring-mail',
    label: 'Mail',
    // Identity pin for the prebuilt-plugin path (required since workspace 0.1.103
    // for any plugin contributing agentTools/systemPrompt). Bump when the
    // executable contribution changes materially.
    contentDigest: 'boring-mail-server-plugin-v3',
    routes: async (app) => {
      const syncLease = await acquireMsgvaultSyncRuntime(
        options.sync,
        (message) => app.log.warn({ component: 'boring-mail-msgvault-sync' }, message),
      )
      app.addHook('onClose', async () => syncLease.release())
      app.post('/api/boring-mail/drafts', async (request, reply) => {
        const body = request.body as { path?: unknown; to?: unknown; cc?: unknown; subject?: unknown; bodyMarkdown?: unknown } | undefined
        const requestedPath = typeof body?.path === 'string' && body.path.trim() ? body.path.trim() : 'drafts/new.mail.md'
        const { path, target } = safeWorkspacePath(requestedPath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, serializeMailDraft({
          to: typeof body?.to === 'string' ? body.to : '',
          cc: typeof body?.cc === 'string' ? body.cc : '',
          subject: typeof body?.subject === 'string' ? body.subject : '',
          bodyMarkdown: typeof body?.bodyMarkdown === 'string' ? body.bodyMarkdown : '',
        }), 'utf8')
        return reply.send({ ok: true, path })
      })
    },
    agentTools: [createMailAgentTool({ workspaceRoot })],
    systemPrompt: [
      'Use the `mail` tool for Boring Mail work instead of shelling into draft files directly.',
      '`mail` can search mail, inspect threads, and create/read/update/delete/move/mock-send .mail.md drafts.',
      'When the tool returns a surface with kind `workspace.open.path`, open that path in the UI; .mail.md paths resolve to the mail draft editor.',
      'When the tool returns kind `boring-mail.thread`, open the corresponding mail thread surface.',
    ].join('\n'),
  })
}
