import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, sep } from 'node:path'
import type { AgentTool, ToolResult } from '@hachej/boring-workspace'
import { mockMailThreads } from '../mockData.ts'
import { BORING_MAIL_THREAD_SURFACE_KIND } from '../shared/constants.ts'

export type MailToolAction =
  | 'search'
  | 'get_thread'
  | 'list_drafts'
  | 'create_draft'
  | 'read_draft'
  | 'update_draft'
  | 'delete_draft'
  | 'move_draft'
  | 'mock_send'

export type MailToolMode = 'live' | 'fixture'
export const LIVE_MAIL_TOOL_REMEDIATION = 'Live mailbox reads are wired on the server bridge but are not visible in the browser until Slice 5; use this tool only for .mail.md draft-file work.'

export interface MailToolOptions {
  workspaceRoot: string
  mode?: MailToolMode
}

interface MailDraftFields {
  to?: string
  cc?: string
  subject?: string
  bodyMarkdown?: string
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeWorkspacePath(root: string, requested: string): { path: string; target: string } {
  const safe = normalize(requested).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '')
  const target = join(root, safe)
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) throw new Error('path escapes workspace')
  return { path: safe.replace(/\\/g, '/'), target }
}

function requireMailDraftPath(root: string, requested: string | undefined): { path: string; target: string } {
  const resolved = safeWorkspacePath(root, requested || `drafts/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mail.md`)
  if (!resolved.path.endsWith('.mail.md')) throw new Error('mail draft paths must end with .mail.md')
  return resolved
}

export function serializeMailDraft(fields: MailDraftFields): string {
  return [
    '---',
    `to: ${fields.to ?? ''}`,
    `cc: ${fields.cc ?? ''}`,
    `subject: ${fields.subject ?? ''}`,
    'kind: boring-mail-draft',
    '---',
    '',
    fields.bodyMarkdown ?? '',
    '',
  ].join('\n')
}

async function listMailDrafts(root: string, dir = 'drafts'): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const { target } = safeWorkspacePath(root, dir)
  try {
    const entries = await readdir(target, { withFileTypes: true })
    const drafts = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mail.md'))
      .map(async (entry) => {
        const path = `${dir.replace(/\/$/, '')}/${entry.name}`
        const info = await stat(join(target, entry.name))
        return { path, size: info.size, mtimeMs: info.mtimeMs }
      }))
    return drafts.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function createMailAgentTool({ workspaceRoot, mode = 'fixture' }: MailToolOptions): AgentTool {
  const live = mode === 'live'
  return {
    name: 'mail',
    description: live
      ? `Manage Boring Mail .mail.md draft files. search/get_thread are fixture-only and do not read live mail. ${LIVE_MAIL_TOOL_REMEDIATION}`
      : 'Manage the Boring Mail workspace: search fixture mail, inspect fixture threads, and create/read/update/delete/move/send .mail.md draft files.',
    promptSnippet: live
      ? `Use the mail tool for .mail.md draft-file work only. search/get_thread are fixture-only and not live mailbox reads. ${LIVE_MAIL_TOOL_REMEDIATION}`
      : 'Use the mail tool for mail work. It supports actions: search, get_thread, list_drafts, create_draft, read_draft, update_draft, delete_draft, move_draft, mock_send. Drafts are real .mail.md files; opening them should use workspace.open.path.',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['search', 'get_thread', 'list_drafts', 'create_draft', 'read_draft', 'update_draft', 'delete_draft', 'move_draft', 'mock_send'] },
        query: { type: 'string', description: 'Search query for sender, subject, snippet, body, or tags.' },
        threadId: { type: 'string', description: 'Mock mail thread id.' },
        path: { type: 'string', description: 'Draft file path, ending in .mail.md.' },
        toPath: { type: 'string', description: 'Destination path for move_draft, ending in .mail.md.' },
        to: { type: 'string' },
        cc: { type: 'string' },
        subject: { type: 'string' },
        bodyMarkdown: { type: 'string' },
      },
      additionalProperties: false,
    },
    async execute(params) {
      try {
        if (!isRecord(params)) return errorResult('mail tool params must be an object')
        const action = stringParam(params, 'action') as MailToolAction | undefined

        if (action === 'search') {
          const query = (stringParam(params, 'query') ?? '').toLowerCase()
          const threads = mockMailThreads.filter((thread) => {
            const haystack = [
              thread.subject,
              thread.sourceLabel,
              thread.snippet,
              thread.tags.join(' '),
              ...thread.messages.map((message) => `${message.sender.name} ${message.sender.email ?? ''} ${message.recipients.map((recipient) => `${recipient.name} ${recipient.email ?? ''}`).join(' ')} ${message.bodyText} ${message.bodyHtml ?? ''}`),
            ].join('\n').toLowerCase()
            return !query || haystack.includes(query)
          }).map((thread) => ({
            id: thread.id,
            subject: thread.subject,
            sourceLabel: thread.sourceLabel,
            snippet: thread.snippet,
            tags: thread.tags,
            unread: thread.unread,
            surface: { kind: BORING_MAIL_THREAD_SURFACE_KIND, target: thread.id },
          }))
          return textResult({ threads })
        }

        if (action === 'get_thread') {
          const threadId = stringParam(params, 'threadId')
          const thread = mockMailThreads.find((item) => item.id === threadId)
          if (!thread) return errorResult(`No thread found for ${threadId ?? '<missing threadId>'}`)
          return textResult({ ...thread, surface: { kind: BORING_MAIL_THREAD_SURFACE_KIND, target: thread.id } })
        }

        if (action === 'list_drafts') {
          return textResult({ drafts: await listMailDrafts(workspaceRoot) })
        }

        if (action === 'create_draft' || action === 'update_draft') {
          const { path, target } = requireMailDraftPath(workspaceRoot, stringParam(params, 'path'))
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, serializeMailDraft({
            to: stringParam(params, 'to') ?? '',
            cc: stringParam(params, 'cc') ?? '',
            subject: stringParam(params, 'subject') ?? '',
            bodyMarkdown: typeof params.bodyMarkdown === 'string' ? params.bodyMarkdown : '',
          }), 'utf8')
          return textResult({ ok: true, path, surface: { kind: 'workspace.open.path', target: path } })
        }

        if (action === 'read_draft') {
          const { path, target } = requireMailDraftPath(workspaceRoot, stringParam(params, 'path'))
          return textResult({ path, content: await readFile(target, 'utf8'), surface: { kind: 'workspace.open.path', target: path } })
        }

        if (action === 'delete_draft') {
          const { path, target } = requireMailDraftPath(workspaceRoot, stringParam(params, 'path'))
          await rm(target, { force: true })
          return textResult({ ok: true, deleted: path })
        }

        if (action === 'move_draft') {
          const from = requireMailDraftPath(workspaceRoot, stringParam(params, 'path'))
          const to = requireMailDraftPath(workspaceRoot, stringParam(params, 'toPath'))
          await mkdir(dirname(to.target), { recursive: true })
          await rename(from.target, to.target)
          return textResult({ ok: true, from: from.path, to: to.path, surface: { kind: 'workspace.open.path', target: to.path } })
        }

        if (action === 'mock_send') {
          const { path, target } = requireMailDraftPath(workspaceRoot, stringParam(params, 'path'))
          const content = await readFile(target, 'utf8')
          const sentPath = `sent/${path.split('/').pop()}`
          const sent = safeWorkspacePath(workspaceRoot, sentPath)
          await mkdir(dirname(sent.target), { recursive: true })
          await writeFile(sent.target, content.replace('kind: boring-mail-draft', 'kind: boring-mail-sent'), 'utf8')
          await rm(target, { force: true })
          return textResult({ ok: true, sent: sent.path, deletedDraft: path, surface: { kind: 'workspace.open.path', target: sent.path } })
        }

        return errorResult(`Unknown mail action: ${action ?? '<missing action>'}`)
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
