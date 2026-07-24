import { useEffect, useMemo, useState } from 'react'
import { MailDraftEditor } from './MailDraftEditor'

interface ParsedMailDraft {
  to: string
  cc: string
  subject: string
  body: string
}

function parseMailDraft(content: string): ParsedMailDraft {
  if (!content.startsWith('---\n')) return { to: '', cc: '', subject: '', body: content }

  const end = content.indexOf('\n---', 4)
  if (end === -1) return { to: '', cc: '', subject: '', body: content }

  const header = content.slice(4, end).split('\n')
  const body = content.slice(end + '\n---'.length).replace(/^\n+/, '')
  const fields = new Map<string, string>()
  for (const line of header) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }

  return {
    to: fields.get('to') ?? '',
    cc: fields.get('cc') ?? '',
    subject: fields.get('subject') ?? '',
    body,
  }
}

export function MailDraftFilePanel({ path }: { path: string }) {
  const [draft, setDraft] = useState<ParsedMailDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDraft(null)
    setError(null)
    fetch(`/api/v1/files?path=${encodeURIComponent(path)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load ${path}`)
        return response.json() as Promise<{ content: string }>
      })
      .then((file) => {
        if (!cancelled) setDraft(parseMailDraft(file.content))
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { cancelled = true }
  }, [path])

  const loadedDraft = useMemo(() => draft, [draft])

  if (error) return <div className="mail-draft-file-state">{error}</div>
  if (!loadedDraft) return <div className="mail-draft-file-state">Loading {path}…</div>

  return (
    <div className="mail-draft-file-panel">
      <MailDraftEditor
        to={loadedDraft.to}
        cc={loadedDraft.cc}
        subject={loadedDraft.subject}
        body={loadedDraft.body}
        sent={sent}
        sendLabel="Send"
        documentPath={path}
        onToChange={(to) => setDraft((current) => current ? { ...current, to } : current)}
        onCcChange={(cc) => setDraft((current) => current ? { ...current, cc } : current)}
        onSubjectChange={(subject) => setDraft((current) => current ? { ...current, subject } : current)}
        onBodyChange={(body) => setDraft((current) => current ? { ...current, body } : current)}
        onMockSend={() => setSent(true)}
      />
    </div>
  )
}
