import { Mail } from 'lucide-react'
import { definePlugin, type PaneProps, type WorkspaceSourceProps } from '@hachej/boring-workspace/plugin'
import { MailSourcePane } from '../mail/client/MailSourcePane'
import { MailThreadPanel } from '../mail/client/MailThreadPanel'
import { MailDraftFilePanel } from '../mail/client/MailDraftFilePanel'
import { findMockMailThread, mockMailThreads } from '../mail/mockData'
import { BORING_MAIL_PLUGIN_ID, BORING_MAIL_THREAD_SURFACE_KIND } from '../mail/shared/constants'
import type { MailThread } from '../shared/types'

const THREAD_PANEL_ID = 'boring-mail.thread'
const DRAFT_FILE_PANEL_ID = 'boring-mail.draft-file'
const SOURCE_ID = 'boring-mail.source'

function BoringMailSource(props: WorkspaceSourceProps) {
  const openThread = (thread: MailThread) => {
    props.openPanel?.({
      id: `${THREAD_PANEL_ID}.${thread.id}`,
      component: THREAD_PANEL_ID,
      title: thread.subject,
      params: { threadId: thread.id },
    })
  }

  const openCompose = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const path = `drafts/${stamp}.mail.md`
    await fetch('/api/boring-mail/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, to: '', cc: '', subject: '', bodyMarkdown: '' }),
    })
    props.openPanel?.({
      id: `mail-draft:${path}`,
      component: DRAFT_FILE_PANEL_ID,
      title: titleFromPath(path),
      params: { path },
    })
  }

  return <MailSourcePane openThread={openThread} openCompose={openCompose} />
}

function BoringMailThreadPanel({ params }: PaneProps<{ threadId?: string }>) {
  return <MailThreadPanel threadId={params?.threadId ?? ''} onSent={() => {}} />
}

function BoringMailDraftFilePanel({ params }: PaneProps<{ path?: string }>) {
  return <MailDraftFilePanel path={params?.path ?? 'drafts/new.mail.md'} />
}

function titleFromPath(path: string): string {
  return path.split('/').pop() || path
}

export const boringMailBoringUiPlugin = definePlugin({
  id: BORING_MAIL_PLUGIN_ID,
  label: 'Mail',
  workspaceSources: [
    {
      id: SOURCE_ID,
      label: 'Mail',
      icon: Mail,
      component: BoringMailSource,
      source: 'app',
    },
  ],
  panels: [
    {
      id: THREAD_PANEL_ID,
      label: 'Email',
      icon: Mail,
      placement: 'shared-dockview',
      component: BoringMailThreadPanel,
      source: 'app',
    },
    {
      id: DRAFT_FILE_PANEL_ID,
      label: 'Mail draft',
      icon: Mail,
      placement: 'center',
      component: BoringMailDraftFilePanel,
      source: 'app',
    },
  ],
  surfaceResolvers: [
    {
      id: 'boring-mail.open-mail-draft-file',
      kind: 'workspace.open.path',
      title: 'Open mail draft file',
      targetHint: 'drafts/message.mail.md',
      examples: [{ target: 'drafts/new.mail.md', label: 'New mail draft' }],
      source: 'app',
      resolve: (request) => {
        const path = request.target
        if (!path.endsWith('.mail.md')) return undefined
        return {
          id: `mail-draft:${path}`,
          component: DRAFT_FILE_PANEL_ID,
          title: titleFromPath(path),
          params: { path },
          score: 100,
        }
      },
    },
    {
      id: 'boring-mail.open-thread',
      kind: BORING_MAIL_THREAD_SURFACE_KIND,
      title: 'Open mail thread',
      targetHint: 'Opaque boring-mail thread id',
      examples: mockMailThreads.slice(0, 2).map((thread) => ({ target: thread.id, label: thread.subject })),
      source: 'app',
      resolve: (request) => {
        const thread = findMockMailThread(request.target)
        if (!thread) return undefined
        return {
          id: `${THREAD_PANEL_ID}.${thread.id}`,
          component: THREAD_PANEL_ID,
          title: thread.subject,
          params: { threadId: thread.id },
        }
      },
    },
  ],
})

export default boringMailBoringUiPlugin
