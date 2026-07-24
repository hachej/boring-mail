import { useEffect, useMemo, useRef, useState } from 'react'
import { Edit3, Search, Star, X } from 'lucide-react'
import type { MailThread, MailViewId } from '../../shared/types'
import type { MailWorkspaceSourceProps } from '../../plugin-host/definePlugin'
import { mockMailThreads } from '../mockData'
import { allTags, filterThreads, viewOptions } from './mailLogic'

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function ThreadRow({ thread, onOpen }: { thread: MailThread; onOpen(): void }) {
  return (
    <button type="button" className="thread-row" onClick={onOpen}>
      <span className={`unread-dot ${thread.unread ? 'active' : ''}`} />
      <span className="thread-row-main">
        <span className="thread-row-meta">
          <strong>{thread.sourceLabel}</strong>
          {thread.starred ? <Star className="star" size={13} /> : null}
          <time>{formatTime(thread.lastMessageAt)}</time>
        </span>
        <span className={`thread-subject ${thread.unread ? 'unread' : ''}`}>{thread.subject}</span>
        <span className="thread-snippet">{thread.snippet}</span>
        <span className="thread-tags">{thread.tags.slice(0, 3).map((tag) => <small key={tag}>{tag}</small>)}</span>
      </span>
    </button>
  )
}

export function MailSourcePane({ openThread, openCompose }: MailWorkspaceSourceProps) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<MailViewId>('inbox')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const tags = useMemo(() => allTags(mockMailThreads), [])
  const threads = useMemo(() => filterThreads(mockMailThreads, view, selectedTags, query), [query, selectedTags, view])
  const didOpenInitialThread = useRef(false)

  useEffect(() => {
    if (didOpenInitialThread.current || query || selectedTags.length || view !== 'inbox' || !threads[0]) return
    const thread = threads[0]
    const timeout = window.setTimeout(() => {
      if (didOpenInitialThread.current) return
      openThread(thread)
      didOpenInitialThread.current = true
    }, 450)
    return () => window.clearTimeout(timeout)
  }, [openThread, query, selectedTags.length, threads, view])

  const toggleTag = (tag: string) => setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])

  return (
    <aside className="mail-source-pane">
      <header className="source-header">
        <div className="source-title">
          <small>{threads.length} threads</small>
        </div>
        <button type="button" className="mail-compose-button" onClick={openCompose}>
          <Edit3 size={13} />
          Compose
        </button>
      </header>
      <label className="search-box">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search mail..." />
      </label>
      <div className="source-controls" aria-label="Mail views">
        <div className="mail-view-tabs" role="tablist" aria-label="Mail views">
          {viewOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={view === option.id}
              className={view === option.id ? 'mail-view-tab active' : 'mail-view-tab'}
              onClick={() => setView(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {selectedTags.length ? <button type="button" className="icon-button" onClick={() => setSelectedTags([])} title="Clear tags"><X size={14} /></button> : null}
      </div>
      <div className="tag-scroll" aria-label="Tag filters">
        {tags.map((tag) => (
          <button key={tag} type="button" className={selectedTags.includes(tag) ? 'tag-chip selected' : 'tag-chip'} onClick={() => toggleTag(tag)}>
            {tag}
          </button>
        ))}
      </div>
      <div className="thread-list">
        {threads.length ? threads.map((thread) => <ThreadRow key={thread.id} thread={thread} onOpen={() => openThread(thread)} />) : <p className="empty-state">No mock mail matches this view.</p>}
      </div>
    </aside>
  )
}
