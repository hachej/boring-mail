import { useState } from 'react'
import { Paperclip } from 'lucide-react'
import type { MailThread } from '../../shared/types'
import { findMockMailThread } from '../mockData'
import { MailDraftEditor } from './MailDraftEditor'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ThreadMessage({ thread }: { thread: MailThread }) {
  return (
    <>
      {thread.messages.map((message) => (
        <article key={message.id} className="message-card">
          <header className="message-header">
            <div>
              <strong>{message.sender.name}</strong> <span>{message.sender.email}</span>
              <p>to {message.recipients.map((recipient) => recipient.name).join(', ')}</p>
            </div>
            <time>{new Date(message.sentAt).toLocaleString()}</time>
          </header>
          {message.bodyHtml ? <div className="message-html" dangerouslySetInnerHTML={{ __html: message.bodyHtml }} /> : <p className="message-text">{message.bodyText}</p>}
          {message.attachments.length ? (
            <div className="attachment-list">
              {message.attachments.map((attachment) => (
                <div key={attachment.id} className="attachment-pill">
                  <Paperclip size={14} />
                  <strong>{attachment.filename}</strong>
                  <span>{attachment.mediaType} · {formatBytes(attachment.byteSize)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </>
  )
}

export function ComposePanel({ onSent }: { onSent(): void }) {
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('Bonjour,\n\n')
  const [sent, setSent] = useState(false)
  return (
    <MailDraftEditor
      to={to}
      cc={cc}
      subject={subject}
      body={body}
      sent={sent}
      onToChange={setTo}
      onCcChange={setCc}
      onSubjectChange={setSubject}
      onBodyChange={setBody}
      documentPath="drafts/new.mail.md"
      onMockSend={() => { setSent(true); onSent() }}
    />
  )
}

export function MailThreadPanel({ threadId, onSent }: { threadId: string; onSent(): void }) {
  const thread = findMockMailThread(threadId)
  const [replying, setReplying] = useState(false)
  const [replyBody, setReplyBody] = useState('Merci,\n\n')
  const [replySent, setReplySent] = useState(false)

  if (threadId === 'compose') return <ComposePanel onSent={onSent} />
  if (!thread) return <div className="missing-thread">Unknown mock email thread.</div>

  const latest = thread.messages.at(-1)
  return (
    <div className="mail-thread-panel">
      <header className="thread-panel-header">
        <div>
          <h1>{thread.subject}</h1>
          <p>{thread.sourceLabel} · {new Date(thread.lastMessageAt).toLocaleString()}</p>
          <div className="thread-panel-tags">{thread.tags.map((tag) => <small key={tag}>{tag}</small>)}</div>
        </div>
        <button type="button" className="secondary-button" onClick={() => setReplying((value) => !value)}>Reply</button>
      </header>
      <main className="thread-panel-body">
        <ThreadMessage thread={thread} />
        {replying ? (
          <MailDraftEditor
            to={latest?.sender.email ?? latest?.sender.name ?? ''}
            cc=""
            subject={`Re: ${thread.subject}`}
            body={replyBody}
            sent={replySent}
            sendLabel="Mock reply"
            onToChange={() => {}}
            onCcChange={() => {}}
            onSubjectChange={() => {}}
            onBodyChange={setReplyBody}
            documentPath={`drafts/${thread.id}.reply.mail.md`}
            onMockSend={() => { setReplySent(true); onSent() }}
          />
        ) : null}
      </main>
    </div>
  )
}
