import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createMailAgentTool } from '../mailAgentTool'

function text(output: { content: Array<{ text: string }> }) {
  return JSON.parse(output.content[0]!.text)
}

const ctx = { abortSignal: new AbortController().signal, toolCallId: 'test' }

describe('mail agent tool', () => {
  it('searches mock mail and returns thread surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boring-mail-tool-'))
    const tool = createMailAgentTool({ workspaceRoot: root })
    const result = text(await tool.execute({ action: 'search', query: '' }, ctx))
    expect(result.threads[0].surface.kind).toBe('boring-mail.thread')
  })

  it('creates draft files with mail frontmatter and open-path surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boring-mail-tool-'))
    const tool = createMailAgentTool({ workspaceRoot: root })
    const result = text(await tool.execute({ action: 'create_draft', path: 'drafts/hello.mail.md', to: 'a@b.com', cc: 'c@d.com', subject: 'Hello', bodyMarkdown: 'Body' }, ctx))
    expect(result.surface).toEqual({ kind: 'workspace.open.path', target: 'drafts/hello.mail.md' })
    await expect(readFile(join(root, 'drafts/hello.mail.md'), 'utf8')).resolves.toContain('subject: Hello')
  })

  it('moves and deletes drafts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boring-mail-tool-'))
    const tool = createMailAgentTool({ workspaceRoot: root })
    await tool.execute({ action: 'create_draft', path: 'drafts/a.mail.md' }, ctx)
    const moved = text(await tool.execute({ action: 'move_draft', path: 'drafts/a.mail.md', toPath: 'drafts/b.mail.md' }, ctx))
    expect(moved.to).toBe('drafts/b.mail.md')
    const deleted = text(await tool.execute({ action: 'delete_draft', path: 'drafts/b.mail.md' }, ctx))
    expect(deleted.deleted).toBe('drafts/b.mail.md')
  })
})
