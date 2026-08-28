import { z } from 'zod'
import { ProductStoreError, type UnifiedThreadDetail } from '../store/product/types.js'
import { normalizeAndTruncateProviderEmail, normalizeAndTruncateProviderText, utf8ByteLength } from '../shared/textBounds.js'

const TARGET_MAX_BYTES = 160
const OUTPUT_MAX_BYTES = 480 * 1024
const THREAD_MESSAGE_MAX = 25
const RECIPIENT_MAX = 64
const ATTACHMENT_MAX = 64
const PER_MESSAGE_METADATA_MAX = 20
const BODY_PER_MESSAGE_MAX_BYTES = 64 * 1024
const BODY_TOTAL_MAX_BYTES = 160 * 1024

const utf8BytesAtMost = (max: number) => (value: string) => utf8ByteLength(value) <= max
const normalizedTextAtMost = (max: number) => z.string()
  .refine((value) => value === value.normalize('NFC'), 'text must be NFC normalized')
  .refine((value) => !/[\x00-\x08\x0B-\x1F\x7F]/u.test(value), 'text contains forbidden controls')
  .refine(utf8BytesAtMost(max), `text exceeds ${max} UTF-8 bytes`)
const canonicalEmail = z.string()
  .refine((value) => value === value.normalize('NFC'), 'email must be NFC normalized')
  .refine(utf8BytesAtMost(320), 'email exceeds 320 UTF-8 bytes')
  .refine((value) => !/[\s\x00-\x1F\x7F]/u.test(value), 'email must be printable single-line text')
  .refine((value) => value.indexOf('@') > 0 && value.indexOf('@') === value.lastIndexOf('@') && !value.endsWith('@'), 'email must be canonical email text')
const canonicalUtcTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, 'sentAt must be canonical UTC milliseconds')
  .refine((value) => {
    const instant = new Date(value)
    return Number.isFinite(instant.getTime()) && instant.toISOString() === value
  }, 'sentAt must be a valid canonical UTC instant')
const targetSchema = z.string()
  .min(1)
  .refine(utf8BytesAtMost(TARGET_MAX_BYTES), 'target exceeds 160 UTF-8 bytes')
  .regex(/^[A-Za-z0-9._-]+$/u)

export const mailBridgeThreadInputContract = z.object({
  target: targetSchema,
}).strict()

export const mailBridgeThreadMessageContract = z.object({
  sentAt: canonicalUtcTimestamp.nullable(),
  sender: z.object({
    name: normalizedTextAtMost(512).nullable(),
    email: canonicalEmail.nullable(),
  }).strict(),
  recipients: z.array(z.object({
    type: z.enum(['to', 'cc', 'bcc']),
    name: normalizedTextAtMost(512).nullable(),
    email: canonicalEmail,
  }).strict()).max(RECIPIENT_MAX),
  bodyText: normalizedTextAtMost(BODY_PER_MESSAGE_MAX_BYTES),
  bodyUnavailable: z.boolean(),
  bodyTruncated: z.boolean(),
  attachments: z.array(z.object({
    filename: normalizedTextAtMost(1024).nullable(),
    mimeType: normalizedTextAtMost(255).nullable(),
    byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict()).max(ATTACHMENT_MAX),
  metadataTruncated: z.boolean(),
}).strict()

export const mailBridgeThreadDetailContract = z.object({
  target: targetSchema,
  subject: normalizedTextAtMost(2 * 1024),
  messages: z.array(mailBridgeThreadMessageContract).min(1).max(THREAD_MESSAGE_MAX),
  historyTruncated: z.boolean(),
  selectedOutsideRecentWindow: z.boolean(),
  replyCapability: z.object({
    allowed: z.literal(false),
    reason: z.literal('drafts_not_in_scope'),
  }).strict(),
}).strict().superRefine((thread, ctx) => {
  let bodyBytes = 0
  let recipients = 0
  let attachments = 0
  thread.messages.forEach((message, index) => {
    const messageBodyBytes = utf8ByteLength(message.bodyText)
    bodyBytes += messageBodyBytes
    recipients += message.recipients.length
    attachments += message.attachments.length
    if (messageBodyBytes > BODY_PER_MESSAGE_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['messages', index, 'bodyText'], message: 'body exceeds 64 KiB per-message budget' })
    }
    if (message.recipients.length > PER_MESSAGE_METADATA_MAX) {
      ctx.addIssue({ code: 'custom', path: ['messages', index, 'recipients'], message: 'message exceeds 20-recipient budget' })
    }
    if (message.attachments.length > PER_MESSAGE_METADATA_MAX) {
      ctx.addIssue({ code: 'custom', path: ['messages', index, 'attachments'], message: 'message exceeds 20-attachment budget' })
    }
  })
  if (bodyBytes > BODY_TOTAL_MAX_BYTES) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'thread exceeds 160 KiB body budget' })
  if (recipients > RECIPIENT_MAX) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'thread exceeds 64-recipient budget' })
  if (attachments > ATTACHMENT_MAX) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'thread exceeds 64-attachment budget' })
})

const okOutput = z.object({ status: z.literal('ok'), thread: mailBridgeThreadDetailContract }).strict()
const notFoundOutput = z.object({ status: z.literal('not_found') }).strict()
const unavailableOutput = z.object({ status: z.literal('unavailable') }).strict()

export const mailBridgeThreadOutputContract = z.discriminatedUnion('status', [okOutput, notFoundOutput, unavailableOutput])
  .superRefine((output, ctx) => {
    if (utf8ByteLength(JSON.stringify(output)) >= OUTPUT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'escaped JSON exceeds 480 KiB' })
    }
  })
export const mailBridgeThreadContract = {
  op: 'boring-mail.v1.thread.get',
  input: mailBridgeThreadInputContract,
  output: mailBridgeThreadOutputContract,
} as const

export type BrowserThreadGetInput = z.infer<typeof mailBridgeThreadInputContract>
export type BrowserThreadMessage = z.infer<typeof mailBridgeThreadMessageContract>
export type BrowserThreadDetail = z.infer<typeof mailBridgeThreadDetailContract>
export type BrowserThreadGetOutput = z.infer<typeof mailBridgeThreadOutputContract>

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ProductStoreError('corrupt_data', `${name} must be a positive safe integer`)
  }
  return value as number
}
function exactKeys(value: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(value).sort().join(',')
  const wanted = [...expected].sort().join(',')
  if (actual !== wanted) throw new ProductStoreError('corrupt_data', `${name} has unexpected internal fields`)
}
function validateNullableText(value: unknown, name: string, maxBytes: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new ProductStoreError('corrupt_data', `${name} must be text or null`)
  const normalized = normalizeAndTruncateProviderText(value, maxBytes)
  if (normalized.value !== value || normalized.truncated) {
    throw new ProductStoreError('corrupt_data', `${name} violates normalized byte bounds`)
  }
  return value
}
function validateNullableEmail(value: unknown, name: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new ProductStoreError('corrupt_data', `${name} must be text or null`)
  const normalized = normalizeAndTruncateProviderEmail(value, 320)
  if (normalized.value !== value || normalized.truncated || !canonicalEmail.safeParse(value).success) {
    throw new ProductStoreError('corrupt_data', `${name} violates email bounds`)
  }
  return value
}
function validateInternalThreadDetail(detail: UnifiedThreadDetail): void {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new ProductStoreError('corrupt_data', 'thread detail must be an object')
  }
  exactKeys(detail as unknown as Record<string, unknown>, [
    'historyTruncated', 'messages', 'replyCapability', 'selectedMessageId', 'selectedOutsideRecentWindow', 'subject',
  ], 'thread detail')
  const selectedMessageId = positiveSafeInteger(detail.selectedMessageId, 'selectedMessageId')
  validateNullableText(detail.subject, 'thread subject', 2 * 1024)
  if (!Array.isArray(detail.messages) || detail.messages.length < 1 || detail.messages.length > THREAD_MESSAGE_MAX) {
    throw new ProductStoreError('corrupt_data', 'thread detail must contain 1..25 messages')
  }
  if (detail.replyCapability?.allowed !== false || detail.replyCapability.reason !== 'drafts_not_in_scope') {
    throw new ProductStoreError('corrupt_data', 'thread reply capability must be disabled')
  }
  if (typeof detail.historyTruncated !== 'boolean' || typeof detail.selectedOutsideRecentWindow !== 'boolean') {
    throw new ProductStoreError('corrupt_data', 'thread truncation flags must be boolean')
  }
  let selectedCount = 0
  let bodyBytes = 0
  let recipientCount = 0
  let attachmentCount = 0
  for (const [index, message] of detail.messages.entries()) {
    exactKeys(message as unknown as Record<string, unknown>, [
      'attachments', 'bodyText', 'bodyTruncated', 'bodyUnavailable', 'messageId', 'metadataTruncated',
      'recipients', 'selected', 'sender', 'sentAt',
    ], `thread message ${index}`)
    const messageId = positiveSafeInteger(message.messageId, 'thread message id')
    if (typeof message.selected !== 'boolean') throw new ProductStoreError('corrupt_data', 'message selected flag must be boolean')
    if (message.selected) {
      selectedCount++
      if (messageId !== selectedMessageId) throw new ProductStoreError('corrupt_data', 'selected message id mismatch')
    }
    if (message.sentAt !== null && typeof message.sentAt !== 'string') {
      throw new ProductStoreError('corrupt_data', 'message sentAt must be text or null')
    }
    exactKeys(message.sender as unknown as Record<string, unknown>, ['email', 'name'], `thread message ${index} sender`)
    validateNullableText(message.sender.name, 'sender name', 512)
    validateNullableEmail(message.sender.email, 'sender email')
    if (typeof message.bodyText !== 'string' || typeof message.bodyUnavailable !== 'boolean' ||
        typeof message.bodyTruncated !== 'boolean' || typeof message.metadataTruncated !== 'boolean') {
      throw new ProductStoreError('corrupt_data', 'message body and truncation fields are invalid')
    }
    const messageBodyBytes = utf8ByteLength(message.bodyText)
    if (messageBodyBytes > BODY_PER_MESSAGE_MAX_BYTES) {
      throw new ProductStoreError('corrupt_data', 'message body exceeds 64 KiB')
    }
    bodyBytes += messageBodyBytes
    if (!Array.isArray(message.recipients) || message.recipients.length > PER_MESSAGE_METADATA_MAX ||
        !Array.isArray(message.attachments) || message.attachments.length > PER_MESSAGE_METADATA_MAX) {
      throw new ProductStoreError('corrupt_data', 'message metadata exceeds per-message budgets')
    }
    recipientCount += message.recipients.length
    attachmentCount += message.attachments.length
    for (const recipient of message.recipients) {
      exactKeys(recipient as unknown as Record<string, unknown>, ['email', 'name', 'type'], 'thread recipient')
      if (recipient.type !== 'to' && recipient.type !== 'cc' && recipient.type !== 'bcc') {
        throw new ProductStoreError('corrupt_data', 'recipient type is invalid')
      }
      validateNullableText(recipient.name, 'recipient name', 512)
      validateNullableEmail(recipient.email, 'recipient email')
    }
    for (const attachment of message.attachments) {
      exactKeys(attachment as unknown as Record<string, unknown>, ['byteSize', 'filename', 'mimeType'], 'thread attachment')
      validateNullableText(attachment.filename, 'attachment filename', 1024)
      validateNullableText(attachment.mimeType, 'attachment mimeType', 255)
      if (attachment.byteSize !== null && (!Number.isSafeInteger(attachment.byteSize) || Number(attachment.byteSize) < 0)) {
        throw new ProductStoreError('corrupt_data', 'attachment byteSize is invalid')
      }
    }
  }
  if (selectedCount !== 1) throw new ProductStoreError('corrupt_data', 'thread detail must contain exactly one selected message')
  if (bodyBytes > BODY_TOTAL_MAX_BYTES || recipientCount > RECIPIENT_MAX || attachmentCount > ATTACHMENT_MAX) {
    throw new ProductStoreError('corrupt_data', 'thread detail exceeds global budgets')
  }
}

function mapMessageAt(value: string | null): string | null {
  if (value === null) return null
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\+00:00$/u.exec(value)
  if (!match) throw new ProductStoreError('corrupt_data', 'sentAt must be canonical UTC text')
  const [, y, m, d, h, min, sec, fraction = ''] = match
  const millis = fraction.padEnd(3, '0').slice(0, 3)
  const iso = `${y}-${m}-${d}T${h}:${min}:${sec}.${millis}Z`
  const instant = new Date(iso)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== iso) {
    throw new ProductStoreError('corrupt_data', 'sentAt must be canonical UTC text')
  }
  return iso
}
function assertJsonBudget(output: BrowserThreadGetOutput): void {
  if (utf8ByteLength(JSON.stringify(output)) >= OUTPUT_MAX_BYTES) {
    throw new ProductStoreError('corrupt_data', 'browser thread detail JSON exceeds 480 KiB')
  }
}
function toBrowserThread(detail: UnifiedThreadDetail, target: string): BrowserThreadDetail {
  return {
    target,
    subject: normalizeAndTruncateProviderText(detail.subject || '(no subject)', 2 * 1024).value || '(no subject)',
    messages: detail.messages.map((message) => {
      let metadataTruncated = message.metadataTruncated
      const senderName = message.sender.name === null ? { value: null, truncated: false } : normalizeAndTruncateProviderText(message.sender.name, 512)
      const senderEmail = normalizeAndTruncateProviderEmail(message.sender.email, 320)
      metadataTruncated = metadataTruncated || senderName.truncated || senderEmail.truncated ||
        (message.sender.email !== null && senderEmail.value === null)
      const recipients: BrowserThreadMessage['recipients'] = []
      for (const recipient of message.recipients) {
        const name = recipient.name === null ? { value: null, truncated: false } : normalizeAndTruncateProviderText(recipient.name, 512)
        const email = normalizeAndTruncateProviderEmail(recipient.email, 320)
        if (email.value === null) { metadataTruncated = true; continue }
        metadataTruncated = metadataTruncated || name.truncated || email.truncated
        recipients.push({ type: recipient.type, name: name.value, email: email.value })
      }
      const attachments: BrowserThreadMessage['attachments'] = []
      for (const attachment of message.attachments) {
        const filename = attachment.filename === null ? { value: null, truncated: false } : normalizeAndTruncateProviderText(attachment.filename, 1024)
        const mimeType = attachment.mimeType === null ? { value: null, truncated: false } : normalizeAndTruncateProviderText(attachment.mimeType, 255)
        metadataTruncated = metadataTruncated || filename.truncated || mimeType.truncated
        attachments.push({
          filename: filename.value,
          mimeType: mimeType.value,
          byteSize: Number.isSafeInteger(attachment.byteSize) && Number(attachment.byteSize) >= 0 ? attachment.byteSize : null,
        })
      }
      const body = normalizeAndTruncateProviderText(message.bodyText, BODY_PER_MESSAGE_MAX_BYTES)
      return {
        sentAt: mapMessageAt(message.sentAt),
        sender: { name: senderName.value, email: senderEmail.value },
        recipients,
        bodyText: body.value,
        bodyUnavailable: message.bodyUnavailable,
        bodyTruncated: message.bodyTruncated || body.truncated,
        attachments,
        metadataTruncated,
      }
    }),
    historyTruncated: detail.historyTruncated,
    selectedOutsideRecentWindow: detail.selectedOutsideRecentWindow,
    replyCapability: { allowed: false, reason: 'drafts_not_in_scope' },
  }
}
function trimToJsonBudget(thread: BrowserThreadDetail, detail: UnifiedThreadDetail): BrowserThreadDetail {
  let selectedIndex = detail.messages.findIndex((message) => message.selected)
  const clone: BrowserThreadDetail = JSON.parse(JSON.stringify(thread)) as BrowserThreadDetail
  const output = (): BrowserThreadGetOutput => ({ status: 'ok', thread: clone })
  if (utf8ByteLength(JSON.stringify(output())) < OUTPUT_MAX_BYTES) return clone
  const earliestNonSelected = () => clone.messages
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => index !== selectedIndex)
  for (const { message } of earliestNonSelected()) {
    if (!message.bodyText) continue
    message.bodyText = ''
    message.bodyTruncated = true
    if (utf8ByteLength(JSON.stringify(output())) < OUTPUT_MAX_BYTES) return clone
  }
  for (const { message } of earliestNonSelected()) {
    if (message.recipients.length === 0 && message.attachments.length === 0) continue
    message.recipients = []
    message.attachments = []
    message.metadataTruncated = true
    if (utf8ByteLength(JSON.stringify(output())) < OUTPUT_MAX_BYTES) return clone
  }
  for (let index = 0; index < clone.messages.length && clone.messages.length > 1;) {
    if (index === selectedIndex) { index++; continue }
    clone.messages.splice(index, 1)
    if (index < selectedIndex) selectedIndex--
    clone.historyTruncated = true
    if (utf8ByteLength(JSON.stringify(output())) < OUTPUT_MAX_BYTES) return clone
  }
  return clone
}

export function mapUnifiedThreadToBrowserThread(
  detail: UnifiedThreadDetail | null,
  target: string,
): BrowserThreadGetOutput {
  if (detail === null) return { status: 'not_found' }
  validateInternalThreadDetail(detail)
  const thread = trimToJsonBudget(toBrowserThread(detail, target), detail)
  const parsed = mailBridgeThreadOutputContract.safeParse({ status: 'ok', thread })
  if (!parsed.success) throw new ProductStoreError('corrupt_data', 'browser thread detail violates bridge contract')
  assertJsonBudget(parsed.data)
  return parsed.data
}
