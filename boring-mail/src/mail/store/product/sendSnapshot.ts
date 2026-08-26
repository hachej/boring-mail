import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import type { DraftInput, DraftRecord, MailAttachment, SendSnapshot } from './types.js'
import { ProductStoreError } from './types.js'

export interface NormalizedDraft {
  path: string
  accountId: string
  sendAsAddress: string
  reply?: { rfc822MessageId: string; sourceId: number }
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyMarkdown: string
  attachments: MailAttachment[]
}

export interface SendContentRow {
  account_id: string
  send_as_address: string
  reply_rfc822_message_id: string | null
  reply_source_id: number | null
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_markdown: string
  attachments_json: string
}

export interface SnapshotRow extends SendContentRow {
  message_id: string
}

function invalid(message: string): never {
  throw new ProductStoreError('invalid_input', message)
}

function normalizeAddress(address: string): string {
  const value = address.trim().toLowerCase()
  if (!value) invalid('mail address may not be empty')
  return value
}

function normalizePath(path: string): string {
  const slash = path.replace(/\\/g, '/')
  if (!slash || slash.startsWith('/') || slash.split('/').includes('..')) {
    invalid('draft path must be workspace-relative and may not escape')
  }
  const normalized = posix.normalize(slash).replace(/^\.\//, '')
  if (!normalized.endsWith('.mail.md')) invalid('draft path must end with .mail.md')
  return normalized
}

function normalizeAttachments(attachments: MailAttachment[]): MailAttachment[] {
  return attachments.map((attachment) => {
    if (!attachment.name || !attachment.mimeType || !attachment.contentHash) {
      invalid('attachment name, mime type and content hash are required')
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      invalid('attachment size must be a non-negative safe integer')
    }
    return { ...attachment }
  })
}

export function normalizeDraft(input: DraftInput): NormalizedDraft {
  if (!input.accountId.trim()) invalid('account id is required')
  if (input.to.length === 0) invalid('at least one To recipient is required')
  let reply: NormalizedDraft['reply']
  if (input.reply) {
    const rfc822MessageId = input.reply.rfc822MessageId.trim()
    if (!rfc822MessageId || !Number.isSafeInteger(input.reply.sourceId)) {
      invalid('reply requires a message id and integer source id')
    }
    reply = { rfc822MessageId, sourceId: input.reply.sourceId }
  }
  return {
    path: normalizePath(input.path),
    accountId: input.accountId.trim(),
    sendAsAddress: normalizeAddress(input.sendAsAddress),
    ...(reply ? { reply } : {}),
    to: input.to.map(normalizeAddress),
    cc: (input.cc ?? []).map(normalizeAddress),
    bcc: (input.bcc ?? []).map(normalizeAddress),
    subject: input.subject,
    bodyMarkdown: input.bodyMarkdown,
    attachments: normalizeAttachments(input.attachments ?? []),
  }
}

/** Stable object-key ordering; array order is intentionally preserved. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function draftContentDigest(draft: NormalizedDraft | DraftRecord): string {
  const { path: _registryPath, ...wireContent } = draft
  return sha256(wireContent)
}

export function createSendSnapshot(draft: NormalizedDraft): SendSnapshot {
  const { path: _registryPath, ...wireContent } = draft
  return {
    ...wireContent,
    messageId: `<out-${randomBytes(16).toString('hex')}@boring-mail.invalid>`,
  }
}

export function sendSnapshotDigest(snapshot: SendSnapshot): string {
  return sha256(snapshot)
}

export function sendContentFromRow(row: SendContentRow): Omit<SendSnapshot, 'messageId'> {
  return {
    accountId: row.account_id,
    sendAsAddress: row.send_as_address,
    ...(row.reply_rfc822_message_id && row.reply_source_id != null
      ? { reply: { rfc822MessageId: row.reply_rfc822_message_id, sourceId: row.reply_source_id } }
      : {}),
    to: JSON.parse(row.to_json) as string[],
    cc: JSON.parse(row.cc_json) as string[],
    bcc: JSON.parse(row.bcc_json) as string[],
    subject: row.subject,
    bodyMarkdown: row.body_markdown,
    attachments: JSON.parse(row.attachments_json) as MailAttachment[],
  }
}

export function snapshotFromRow(row: SnapshotRow): SendSnapshot {
  return { ...sendContentFromRow(row), messageId: row.message_id }
}
