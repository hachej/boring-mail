import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import {
  ProductStoreError,
  type DraftInput,
  type DraftRecord,
  type MailAttachment,
  type ResolvedReplyTarget,
  type SendContent,
  type SendSnapshot,
} from './types.js'

export interface NormalizedDraftFields {
  path: string
  sendAsAddress: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyMarkdown: string
  attachments: MailAttachment[]
}
const invalid = (message: string): never => {
  throw new ProductStoreError('invalid_input', message)
}
const address = (input: string): string => {
  const value = input.trim().toLowerCase()
  if (!value) invalid('mail address may not be empty')
  return value
}
function path(input: string): string {
  const slash = input.replace(/\\/g, '/')
  if (!slash || slash.startsWith('/') || slash.split('/').includes('..'))
    invalid('draft path must be workspace-relative and may not escape')
  const value = posix.normalize(slash).replace(/^\.\//, '')
  if (!value.endsWith('.mail.md')) invalid('draft path must end with .mail.md')
  return value
}
function attachments(input: MailAttachment[]): MailAttachment[] {
  return input.map((item) => {
    if (!item.name || !item.mimeType || !item.contentHash)
      invalid('attachment name, mime type and content hash are required')
    if (!Number.isSafeInteger(item.size) || item.size < 0)
      invalid('attachment size must be a non-negative safe integer')
    return { ...item }
  })
}
export function normalizeDraftFields(input: DraftInput): NormalizedDraftFields {
  if (!Array.isArray(input.to) || input.to.length === 0) invalid('at least one To recipient is required')
  return {
    path: path(input.path),
    sendAsAddress: address(input.sendAsAddress),
    to: input.to.map(address),
    cc: (input.cc ?? []).map(address),
    bcc: (input.bcc ?? []).map(address),
    subject: input.subject,
    bodyMarkdown: input.bodyMarkdown,
    attachments: attachments(input.attachments ?? []),
  }
}

/** The only allowlist of bytes/identity covered by approval. */
export function projectSendContent(input: SendContent): SendContent {
  return {
    accountId: input.accountId,
    sendAsAddress: input.sendAsAddress,
    ...(input.reply
      ? {
          reply: {
            messageId: input.reply.messageId,
            rfc822MessageId: input.reply.rfc822MessageId,
            sourceId: input.reply.sourceId,
          },
        }
      : {}),
    to: [...input.to],
    cc: [...input.cc],
    bcc: [...input.bcc],
    subject: input.subject,
    bodyMarkdown: input.bodyMarkdown,
    attachments: input.attachments.map((item) => ({
      name: item.name,
      mimeType: item.mimeType,
      contentHash: item.contentHash,
      size: item.size,
    })),
  }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export function draftContentDigest(input: SendContent | DraftRecord): string {
  return digest(projectSendContent(input))
}
export function createSendSnapshot(input: SendContent): SendSnapshot {
  return {
    ...projectSendContent(input),
    messageId: `<out-${randomBytes(16).toString('hex')}@boring-mail.invalid>`,
  }
}
export function sendSnapshotDigest(input: SendSnapshot): string {
  return digest({ ...projectSendContent(input), messageId: input.messageId })
}
export function resolvedReply(
  messageId: number,
  target: Omit<ResolvedReplyTarget, 'messageId'>,
): ResolvedReplyTarget {
  return { messageId, ...target }
}
