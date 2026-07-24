import type { MailThread, MailViewId } from '../../shared/types'

export const viewOptions: Array<{ id: MailViewId; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'all', label: 'All mail' },
  { id: 'sent', label: 'Sent' },
  { id: 'starred', label: 'Starred' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'trash', label: 'Trash' },
]

export function allTags(threads: MailThread[]): string[] {
  return [...new Set(threads.flatMap((thread) => thread.tags))].sort((a, b) => a.localeCompare(b))
}

export function matchesQuery(thread: MailThread, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    thread.subject,
    thread.snippet,
    thread.sourceLabel,
    ...thread.tags,
    ...thread.participants.flatMap((participant) => [participant.name, participant.email ?? '']),
  ].join('\n').toLowerCase()
  return haystack.includes(q)
}

export function filterThreads(threads: MailThread[], view: MailViewId, selectedTags: string[], query: string): MailThread[] {
  return threads
    .filter((thread) => view === 'all' ? thread.mailbox !== 'trash' : view === 'starred' ? thread.starred : thread.mailbox === view)
    .filter((thread) => selectedTags.every((tag) => thread.tags.includes(tag)))
    .filter((thread) => matchesQuery(thread, query))
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
}

export function renderMarkdownInline(markdown: string): string {
  return markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br />')
}
