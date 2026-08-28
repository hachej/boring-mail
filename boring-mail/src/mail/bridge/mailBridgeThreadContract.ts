import { z } from 'zod'
import { ProductStoreError, type UnifiedThreadDetail } from '../store/product/types.js'
import { normalizeAndTruncateProviderEmail, normalizeAndTruncateProviderText, utf8ByteLength } from '../shared/textBounds.js'

const TARGET_MAX_BYTES = 160
const OUTPUT_MAX_BYTES = 480 * 1024
const THREAD_MESSAGE_MAX = 25
const RECIPIENT_MAX = 64
const ATTACHMENT_MAX = 64

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
  bodyText: normalizedTextAtMost(160 * 1024),
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
}).strict()

const okOutput = z.object({ status: z.literal('ok'), thread: mailBridgeThreadDetailContract }).strict()
const notFoundOutput = z.object({ status: z.literal('not_found') }).strict()
const unavailableOutput = z.object({ status: z.literal('unavailable') }).strict()

export const mailBridgeThreadOutputContract = z.discriminatedUnion('status', [okOutput, notFoundOutput, unavailableOutput])
export const mailBridgeThreadContract = {
  op: 'boring-mail.v1.thread.get',
  input: mailBridgeThreadInputContract,
  output: mailBridgeThreadOutputContract,
} as const

export type BrowserThreadGetInput = z.infer<typeof mailBridgeThreadInputContract>
export type BrowserThreadMessage = z.infer<typeof mailBridgeThreadMessageContract>
export type BrowserThreadDetail = z.infer<typeof mailBridgeThreadDetailContract>
export type BrowserThreadGetOutput = z.infer<typeof mailBridgeThreadOutputContract>

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
    messages: detail.messages.map((message) => ({
      sentAt: mapMessageAt(message.sentAt),
      sender: {
        name: message.sender.name === null ? null : normalizeAndTruncateProviderText(message.sender.name, 512).value,
        email: normalizeAndTruncateProviderEmail(message.sender.email, 320).value,
      },
      recipients: message.recipients.map((recipient) => ({
        type: recipient.type,
        name: recipient.name === null ? null : normalizeAndTruncateProviderText(recipient.name, 512).value,
        email: normalizeAndTruncateProviderEmail(recipient.email, 320).value,
      })).filter((recipient): recipient is BrowserThreadMessage['recipients'][number] => recipient.email !== null),
      bodyText: normalizeAndTruncateProviderText(message.bodyText, 160 * 1024).value,
      bodyUnavailable: message.bodyUnavailable,
      bodyTruncated: message.bodyTruncated,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename === null ? null : normalizeAndTruncateProviderText(attachment.filename, 1024).value,
        mimeType: attachment.mimeType === null ? null : normalizeAndTruncateProviderText(attachment.mimeType, 255).value,
        byteSize: Number.isSafeInteger(attachment.byteSize) && Number(attachment.byteSize) >= 0 ? attachment.byteSize : null,
      })),
      metadataTruncated: message.metadataTruncated,
    })),
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
  const thread = trimToJsonBudget(toBrowserThread(detail, target), detail)
  const parsed = mailBridgeThreadOutputContract.safeParse({ status: 'ok', thread })
  if (!parsed.success) throw new ProductStoreError('corrupt_data', 'browser thread detail violates bridge contract')
  assertJsonBudget(parsed.data)
  return parsed.data
}
