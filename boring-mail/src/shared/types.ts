export type MailViewId = 'inbox' | 'all' | 'sent' | 'starred' | 'snoozed' | 'trash'

export interface Participant {
  name: string
  email?: string
  kind?: 'person' | 'agent' | 'system'
}

export interface MailAttachment {
  id: string
  filename: string
  mediaType: string
  byteSize: number
}

export interface MailMessage {
  id: string
  sender: Participant
  recipients: Participant[]
  sentAt: string
  bodyText: string
  bodyHtml?: string
  attachments: MailAttachment[]
}

export interface MailThread {
  id: string
  subject: string
  snippet: string
  sourceLabel: string
  mailbox: MailViewId
  unread: boolean
  starred: boolean
  tags: string[]
  participants: Participant[]
  lastMessageAt: string
  messages: MailMessage[]
}

export interface DraftMail {
  id: string
  mode: 'compose' | 'reply'
  to: string
  cc: string
  subject: string
  bodyMarkdown: string
  sourceThreadId?: string
  sent: boolean
}

export interface MailArtifactRef {
  type: 'surface'
  surfaceKind: 'boring-mail.thread'
  target: string
}

export function mailThreadArtifact(threadId: string): MailArtifactRef {
  return { type: 'surface', surfaceKind: 'boring-mail.thread', target: threadId }
}
