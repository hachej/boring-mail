import { describe, expect, it } from 'vitest'
import { mockMailThreads } from '../../mockData'
import { filterThreads, renderMarkdownInline } from '../mailLogic'
import { mailThreadArtifact } from '../../../shared/types'

describe('mock mail workbench logic', () => {
  it('filters by view, tag, and query', () => {
    expect(filterThreads(mockMailThreads, 'inbox', ['important'], '').map((thread) => thread.id)).toEqual([
      'thread_demo_agent_pr_003',
      'thread_demo_invoice_002',
    ])
    expect(filterThreads(mockMailThreads, 'all', ['newsletter'], 'offshore')).toHaveLength(1)
    expect(filterThreads(mockMailThreads, 'sent', [], 'Lakeview')).toHaveLength(1)
  })

  it('uses opaque boring-mail.thread artifact refs', () => {
    expect(mailThreadArtifact('thread_demo_invoice_002')).toEqual({
      type: 'surface',
      surfaceKind: 'boring-mail.thread',
      target: 'thread_demo_invoice_002',
    })
  })

  it('renders a minimal .mail.md preview safely', () => {
    expect(renderMarkdownInline('Hello **Demo** <script>bad</script>')).toContain('<strong>Demo</strong>')
    expect(renderMarkdownInline('Hello **Demo** <script>bad</script>')).toContain('&lt;script&gt;bad&lt;/script&gt;')
  })
})
