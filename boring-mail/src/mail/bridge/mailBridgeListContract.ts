import { z } from 'zod'
import { ProductStoreError, type UnifiedInboxPage } from '../store/product/types.js'
import { normalizeAndTruncateProviderEmail, normalizeAndTruncateProviderText, utf8ByteLength } from '../shared/textBounds.js'

const CURSOR_MAX_BYTES = 2_048
const TARGET_MAX_BYTES = 160
const OUTPUT_MAX_BYTES = 480 * 1_024
const LIST_LIMIT_MAX = 50

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
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, 'messageAt must be canonical UTC milliseconds')
  .refine((value) => {
    const instant = new Date(value)
    return Number.isFinite(instant.getTime()) && instant.toISOString() === value
  }, 'messageAt must be a valid canonical UTC instant')
const targetSchema = z.string()
  .min(1)
  .refine(utf8BytesAtMost(TARGET_MAX_BYTES), 'target exceeds 160 UTF-8 bytes')
  .regex(/^[A-Za-z0-9._-]+$/u)

export const mailBridgeListInputContract = z.object({
  limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
  cursor: z.string().min(1).refine(utf8BytesAtMost(CURSOR_MAX_BYTES), 'cursor exceeds 2048 UTF-8 bytes').optional(),
}).strict()

export const mailBridgeInboxItemContract = z.object({
  target: targetSchema,
  senderName: normalizedTextAtMost(512).nullable(),
  senderEmail: canonicalEmail.nullable(),
  subject: normalizedTextAtMost(1_024),
  snippet: normalizedTextAtMost(2_048),
  messageAt: canonicalUtcTimestamp.nullable(),
  unread: z.boolean(),
  hasAttachments: z.boolean(),
  coalesced: z.boolean(),
  copyCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  truncated: z.object({
    senderName: z.boolean(),
    senderEmail: z.boolean(),
    subject: z.boolean(),
    snippet: z.boolean(),
  }).strict(),
}).strict()

const okOutput = z.object({
  status: z.literal('ok'),
  items: z.array(mailBridgeInboxItemContract).max(LIST_LIMIT_MAX),
  nextCursor: z.string().min(1).refine(utf8BytesAtMost(CURSOR_MAX_BYTES), 'nextCursor exceeds 2048 UTF-8 bytes').nullable(),
}).strict()
const staleOutput = z.object({ status: z.literal('stale_cursor') }).strict()
const unavailableOutput = z.object({ status: z.literal('unavailable') }).strict()

export const mailBridgeListOutputContract = z.discriminatedUnion('status', [okOutput, staleOutput, unavailableOutput])
export const mailBridgeListContract = {
  op: 'boring-mail.v1.inbox.list',
  input: mailBridgeListInputContract,
  output: mailBridgeListOutputContract,
} as const

export type BrowserInboxListInput = z.infer<typeof mailBridgeListInputContract>
export type BrowserInboxItem = z.infer<typeof mailBridgeInboxItemContract>
export type BrowserInboxListOutput = z.infer<typeof mailBridgeListOutputContract>
export type InboxTargetFactory = (messageId: number) => string

function assertJsonBudget(output: BrowserInboxListOutput): void {
  const bytes = utf8ByteLength(JSON.stringify(output))
  if (bytes >= OUTPUT_MAX_BYTES) {
    throw new ProductStoreError('corrupt_data', 'browser inbox list JSON exceeds 480 KiB')
  }
}
function mapMessageAt(value: string | null): string | null {
  if (value === null) return null
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\+00:00$/u.exec(value)
  if (!match) throw new ProductStoreError('corrupt_data', 'messageAt must be canonical UTC text')
  const [, y, m, d, h, min, sec, fraction = ''] = match
  const millis = fraction.padEnd(3, '0').slice(0, 3)
  const iso = `${y}-${m}-${d}T${h}:${min}:${sec}.${millis}Z`
  const instant = new Date(iso)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== iso) {
    throw new ProductStoreError('corrupt_data', 'messageAt must be canonical UTC text')
  }
  return iso
}

export function mapUnifiedInboxPageToBrowserList(
  page: UnifiedInboxPage,
  mintTarget: InboxTargetFactory,
): BrowserInboxListOutput {
  if (!page || !Array.isArray(page.items)) throw new ProductStoreError('corrupt_data', 'unified inbox page is invalid')
  if (page.items.length > LIST_LIMIT_MAX) throw new ProductStoreError('corrupt_data', 'browser inbox list cannot exceed 50 items')
  const output: BrowserInboxListOutput = {
    status: 'ok',
    items: page.items.map((item) => {
      const normalizedSubject = normalizeAndTruncateProviderText(item.subject ?? '', 1_024)
      const subject = normalizedSubject.value.trim()
        ? normalizedSubject
        : { value: '(no subject)', truncated: normalizedSubject.truncated }
      const snippet = normalizeAndTruncateProviderText(item.snippet ?? '', 2_048)
      const senderName = item.senderName === null ? { value: null, truncated: false } : normalizeAndTruncateProviderText(item.senderName, 512)
      const senderEmail = normalizeAndTruncateProviderEmail(item.senderEmail, 320)
      return {
        target: mintTarget(item.messageId),
        senderName: senderName.value,
        senderEmail: senderEmail.value,
        subject: subject.value,
        snippet: snippet.value,
        messageAt: mapMessageAt(item.messageAt),
        unread: item.unread,
        hasAttachments: item.hasAttachments,
        coalesced: item.coalesced,
        copyCount: item.copyCount,
        truncated: {
          senderName: item.textTruncated.senderName || senderName.truncated,
          senderEmail: item.textTruncated.senderEmail || senderEmail.truncated,
          subject: item.textTruncated.subject || subject.truncated,
          snippet: item.textTruncated.snippet || snippet.truncated,
        },
      }
    }),
    nextCursor: page.nextCursor,
  }
  const parsed = mailBridgeListOutputContract.safeParse(output)
  if (!parsed.success) throw new ProductStoreError('corrupt_data', 'browser inbox list violates bridge contract')
  assertJsonBudget(parsed.data)
  return parsed.data
}
