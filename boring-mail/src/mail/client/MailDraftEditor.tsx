import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { MarkdownEditor } from '@hachej/boring-workspace'

export interface MailDraftEditorProps {
  to: string
  cc: string
  subject: string
  body: string
  sent?: boolean
  sendLabel?: string
  documentPath?: string
  onToChange(next: string): void
  onCcChange(next: string): void
  onSubjectChange(next: string): void
  onBodyChange(next: string): void
  onMockSend(): void
}

function AddressField({ label, value, onChange }: { label: string; value: string; onChange(next: string): void }) {
  return (
    <label className="address-field" onPointerDown={(event) => event.stopPropagation()}>
      <span>{label}</span>
      <input
        type="text"
        aria-label={label}
        value={value}
        placeholder={label === 'Subject' ? 'Subject' : `${label.toLowerCase()}@example.com`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </label>
  )
}

export function MailDraftEditor({
  to,
  cc,
  subject,
  body,
  sent,
  sendLabel = 'Mock send',
  onToChange,
  onCcChange,
  onSubjectChange,
  onBodyChange,
  documentPath = 'drafts/new.mail.md',
  onMockSend,
}: MailDraftEditorProps) {
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')
  const lastPayloadRef = useRef('')

  useEffect(() => {
    const payload = JSON.stringify({ path: documentPath, to, cc, subject, bodyMarkdown: body })
    if (payload === lastPayloadRef.current) return
    const timeout = window.setTimeout(() => {
      lastPayloadRef.current = payload
      void fetch('/api/boring-mail/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }).then((response) => {
        setSaveState(response.ok ? 'saved' : 'error')
      }).catch(() => setSaveState('error'))
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [body, cc, documentPath, subject, to])

  return (
    <section className="mail-draft-editor" aria-label="Markdown email draft editor">
      <div className="draft-topbar">
        <div className="draft-fields">
          <AddressField label="To" value={to} onChange={onToChange} />
          <AddressField label="Cc" value={cc} onChange={onCcChange} />
          <AddressField label="Subject" value={subject} onChange={onSubjectChange} />
        </div>
        <button className="mail-send-button" type="button" onClick={onMockSend}>
          <Send size={13} />
          {sendLabel}
        </button>
      </div>
      {sent ? <div className="mock-sent-banner">Mock sent. Real provider sending is intentionally out of scope for this spike.</div> : null}
      {saveState === 'error' ? <div className="draft-save-state error">Could not save draft</div> : null}
      <MarkdownEditor
        content={body}
        onChange={onBodyChange}
        placeholder={`Write ${documentPath}...`}
        documentPath={documentPath}
      />
    </section>
  )
}
