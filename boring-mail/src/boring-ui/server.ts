import { lstatSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { defineServerPlugin, type WorkspaceServerPlugin } from '@hachej/boring-workspace/server'
import { createMailAgentTool, serializeMailDraft, type MailToolMode } from '../mail/server/mailAgentTool.ts'
import { createBoringMailBridgeHandlers } from '../mail/server/mailBridgeHandlers.ts'
import { MailRuntimeLifecycleManager, type MailRuntimeLifecycleOptions } from '../mail/server/mailRuntimeLifecycle.ts'
import { createMailThreadTargetAuthority } from '../mail/server/mailTargetAuthority.ts'
import type { MsgvaultSyncRuntimeOptions } from '../mail/sync/msgvaultSyncRuntime.ts'

export { createBoringMailServer } from '../server/index.ts'
export { createMailAgentTool } from '../mail/server/mailAgentTool.ts'

export type BoringMailServerPluginMode = MailToolMode

export interface BoringMailServerPluginOptions {
  workspaceRoot?: string
  /** Explicit deployment mode. Live opens the single store/sync lifecycle and bridge; fixture keeps mock/draft behavior. */
  mode?: BoringMailServerPluginMode
  /** false disables sync; omission auto-enables when a msgvault database exists. */
  sync?: MsgvaultSyncRuntimeOptions | false
  /** Internal test seam for the live lifecycle. */
  mailRuntime?: Omit<MailRuntimeLifecycleOptions, 'sync' | 'logger'>
}

function assertCanonicalContained(root: string, path: string, name: string): void {
  const parts = relative(root, path).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const entry = lstatSync(current, { throwIfNoEntry: false })
    if (!entry) return
    if (entry.isSymbolicLink()) throw new Error(`fixture mail runtime rejects symlink ${name}`)
    const canonical = realpathSync.native(current)
    const rel = relative(root, canonical)
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`fixture mail runtime ${name} escapes workspace root`)
    }
  }
}

function fixtureRuntimeOptions(workspaceRoot: string, overrides: BoringMailServerPluginOptions['mailRuntime']): MailRuntimeLifecycleOptions {
  const rootEntry = lstatSync(workspaceRoot)
  if (rootEntry.isSymbolicLink()) throw new Error('fixture mail runtime rejects symlink workspace root')
  const root = realpathSync.native(workspaceRoot)
  const temporaryRoot = realpathSync.native(tmpdir())
  if (root !== temporaryRoot && !root.startsWith(`${temporaryRoot}${sep}`)) {
    throw new Error('fixture mail runtime requires a canonical temporary workspace root')
  }
  const fixedProductDbPath = join(root, '.boring-mail', 'fixture', 'product', 'mail.db')
  const fixedMsgvaultDbPath = join(root, '.boring-mail', 'fixture', 'msgvault', 'msgvault.db')
  for (const [path, name] of [
    [dirname(fixedProductDbPath), 'product parent'],
    [fixedProductDbPath, 'product database'],
    [dirname(fixedMsgvaultDbPath), 'msgvault parent'],
    [fixedMsgvaultDbPath, 'msgvault database'],
  ] as const) assertCanonicalContained(root, path, name)

  const candidate = overrides as (MailRuntimeLifecycleOptions | undefined)
  if (candidate?.productDbPath && candidate.productDbPath !== fixedProductDbPath) {
    throw new Error('fixture mail runtime product path override is not allowed')
  }
  if (candidate?.msgvaultDbPath && candidate.msgvaultDbPath !== fixedMsgvaultDbPath) {
    throw new Error('fixture mail runtime msgvault path override is not allowed')
  }
  if (candidate?.msgvaultHome) throw new Error('fixture mail runtime msgvault home override is not allowed')
  if (candidate?.sync !== undefined && candidate.sync !== false) throw new Error('fixture mail runtime sync override is not allowed')
  return {
    ...(overrides ?? {}),
    productDbPath: fixedProductDbPath,
    msgvaultDbPath: fixedMsgvaultDbPath,
    sync: false,
    tolerateMissingMsgvault: true,
    requireSyntheticFixture: true,
  }
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

  const mode = options.mode ?? 'fixture'
  const runtimeOptions: MailRuntimeLifecycleOptions = mode === 'fixture'
    ? fixtureRuntimeOptions(workspaceRoot, options.mailRuntime)
    : { ...(options.mailRuntime ?? {}), sync: options.sync }
  const mailRuntime = new MailRuntimeLifecycleManager(runtimeOptions)
  const targetAuthority = createMailThreadTargetAuthority()

  return defineServerPlugin({
    id: 'boring-mail',
    label: 'Mail',
    // Identity pin for the prebuilt-plugin path (required since workspace 0.1.103
    // for any plugin contributing agentTools/systemPrompt). Bump when the
    // executable contribution changes materially.
    contentDigest: `boring-mail-server-plugin-v4-${mode}`,
    workspaceBridgeHandlers: createBoringMailBridgeHandlers({ runtime: mailRuntime, targetAuthority }),
    routes: async (app) => {
      mailRuntime.setLogger({
        warn: (fields, message) => app.log.warn(fields, message),
        info: (fields, message) => app.log.info(fields, message),
        error: (fields, message) => app.log.error(fields, message),
      })
      await mailRuntime.start()
      app.addHook('onClose', async () => mailRuntime.shutdown())

      if (mode === 'live') return
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
    agentTools: [createMailAgentTool({ workspaceRoot, mode })],
    systemPrompt: mode === 'live'
      ? [
          'Use the `mail` tool for Boring Mail draft-file work instead of shelling into draft files directly.',
          '`mail` draft actions create/read/update/delete/move/mock-send .mail.md files; search/get_thread are fixture-only and do not read the live mailbox.',
          'Live inbox and thread reads are wired on the server bridge but are not visible in the browser until Slice 5.',
          'When the tool returns a surface with kind `workspace.open.path`, open that path in the UI; .mail.md paths resolve to the mail draft editor.',
        ].join('\n')
      : [
          'Use the `mail` tool for Boring Mail work instead of shelling into draft files directly.',
          '`mail` can search fixture mail, inspect fixture threads, and create/read/update/delete/move/mock-send .mail.md drafts.',
          'When the tool returns a surface with kind `workspace.open.path`, open that path in the UI; .mail.md paths resolve to the mail draft editor.',
          'When the tool returns kind `boring-mail.thread`, open the corresponding mail thread surface.',
        ].join('\n'),
  })
}
