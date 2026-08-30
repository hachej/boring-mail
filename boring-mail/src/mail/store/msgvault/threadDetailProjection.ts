/**
 * Authorized, physically bounded source-coherent thread detail for msgvault v0.19.
 * All provider text crosses SQLite only through octet_length-guarded BLOB reads.
 */
import { DatabaseSync } from 'node:sqlite'
import { ProductStoreError, type UnifiedThreadAttachment, type UnifiedThreadDetail, type UnifiedThreadMessage, type UnifiedThreadRecipient } from '../product/types.js'
import { normalizeAndTruncateProviderEmail, normalizeAndTruncateProviderText, truncateUtf8, utf8ByteLength } from '../../shared/textBounds.js'
import { type EligibleInboxSource, getMsgvaultIndexCapabilities, quotedSqlIdentifier } from './unifiedInboxProjection.js'

const MAX_MESSAGES = 25
const CANDIDATE_LIMIT = 501
const RECENT_WINDOW = 25
const BODY_TOTAL_BYTES = 160 * 1024
const BODY_SELECTED_RESERVE_BYTES = 64 * 1024
const BODY_PER_MESSAGE_BYTES = 64 * 1024
const RECIPIENT_GLOBAL_LIMIT = 64
const ATTACHMENT_GLOBAL_LIMIT = 64
const PER_MESSAGE_METADATA_LIMIT = 20
const METADATA_QUERY_LIMIT = PER_MESSAGE_METADATA_LIMIT + 1
const TIMESTAMP_BYTES = 64
const SUBJECT_BYTES = 2 * 1024
const NAME_BYTES = 512
const EMAIL_BYTES = 320
const FILENAME_BYTES = 1024
const MIME_BYTES = 255
const TYPE_BYTES = 16
const BODY_FETCH_BYTES = BODY_PER_MESSAGE_BYTES + 4
const SUBJECT_FETCH_BYTES = SUBJECT_BYTES + 4
const NAME_FETCH_BYTES = NAME_BYTES + 4
const EMAIL_FETCH_BYTES = EMAIL_BYTES + 4
const FILENAME_FETCH_BYTES = FILENAME_BYTES + 4
const MIME_FETCH_BYTES = MIME_BYTES + 4
const TYPE_FETCH_BYTES = TYPE_BYTES + 4
const EMPTY_DETAIL_SUBJECT = '(no subject)'
const SQLITE_MAX_SAFE_INTEGER = 9_007_199_254_740_991

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ProductStoreError('corrupt_data', `${name} must be a positive safe integer`)
  }
  return value as number
}
function positiveInput(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ProductStoreError('invalid_input', 'messageId must be a positive safe integer')
  }
  return value as number
}
function booleanSentinel(value: unknown, name: string): boolean {
  if (value === null || value === undefined) return false
  if (value !== 0 && value !== 1) throw new ProductStoreError('corrupt_data', `${name} must be 0 or 1`)
  return value === 1
}
function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new ProductStoreError('corrupt_data', `${name} must be text or null`)
  return value
}
function blobBytes(value: unknown, name: string): Uint8Array | null {
  if (value === null) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return value
  throw new ProductStoreError('corrupt_data', `${name} bounded prefix must be bytes or null`)
}
function continuationByte(value: number): boolean { return value >= 0x80 && value <= 0xbf }
function validThreeByteLeadAndSecond(first: number, second: number): boolean {
  if (first === 0xe0) return second >= 0xa0 && second <= 0xbf
  if (first >= 0xe1 && first <= 0xec) return continuationByte(second)
  if (first === 0xed) return second >= 0x80 && second <= 0x9f
  if (first >= 0xee && first <= 0xef) return continuationByte(second)
  return false
}
function validFourByteLeadAndSecond(first: number, second: number): boolean {
  if (first === 0xf0) return second >= 0x90 && second <= 0xbf
  if (first >= 0xf1 && first <= 0xf3) return continuationByte(second)
  if (first === 0xf4) return second >= 0x80 && second <= 0x8f
  return false
}
function validIncompleteTerminalUtf8Sequence(bytes: Uint8Array): boolean {
  const first = bytes[0]
  if (first === undefined) return false
  if (bytes.length === 1) return first >= 0xc2 && first <= 0xf4
  const second = bytes[1]
  if (second === undefined) return false
  if (bytes.length === 2) {
    return validThreeByteLeadAndSecond(first, second) || validFourByteLeadAndSecond(first, second)
  }
  const third = bytes[2]
  if (third === undefined) return false
  if (bytes.length === 3) {
    return validFourByteLeadAndSecond(first, second) && continuationByte(third)
  }
  return false
}
function decodeUtf8Prefix(bytes: Uint8Array, name: string): { value: string; clippedTerminalBytes: boolean } {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const maxClip = Math.min(3, bytes.length)
  for (let clip = 0; clip <= maxClip; clip++) {
    try {
      const value = decoder.decode(bytes.subarray(0, bytes.length - clip))
      if (clip === 0 || validIncompleteTerminalUtf8Sequence(bytes.subarray(bytes.length - clip))) {
        return { value, clippedTerminalBytes: clip > 0 }
      }
    } catch {
      // Retry only the maximum UTF-8 terminal sequence width. If removing up to
      // three terminal bytes still fails, the invalid byte is interior provider
      // corruption, not a bounded-prefix edge.
    }
  }
  throw new ProductStoreError('corrupt_data', `${name} is not valid UTF-8 text`)
}
interface BoundedText { value: string | null; truncated: boolean }
function boundedProviderText(row: Record<string, unknown>, prefix: string, name: string, maxBytes: number): BoundedText {
  const storageClass = row[`${prefix}_type`]
  if (storageClass !== 'null' && storageClass !== 'text') {
    throw new ProductStoreError('corrupt_data', `${name} storage class must be text or null`)
  }
  const overflowed = booleanSentinel(row[`${prefix}_overflow`], `${name}_overflow`)
  if (storageClass === 'null') return { value: null, truncated: overflowed }
  const bytes = blobBytes(row[`${prefix}_blob`], name)
  if (bytes === null) {
    if (overflowed) return { value: null, truncated: true }
    throw new ProductStoreError('corrupt_data', `${name} text storage missing bytes`)
  }
  const decoded = decodeUtf8Prefix(bytes, name)
  if (decoded.clippedTerminalBytes && !overflowed) throw new ProductStoreError('corrupt_data', `${name} is not valid UTF-8 text`)
  const normalized = normalizeAndTruncateProviderText(decoded.value, maxBytes)
  return { value: normalized.value, truncated: overflowed || decoded.clippedTerminalBytes || normalized.truncated }
}
function validMailAddress(value: string): boolean {
  return value.length > 0 && value.length <= EMAIL_BYTES &&
    !/[\s\x00-\x1F\x7F]/u.test(value) &&
    value.indexOf('@') > 0 && value.indexOf('@') === value.lastIndexOf('@') && !value.endsWith('@')
}
function boundedProviderEmail(row: Record<string, unknown>, prefix: string, name: string): BoundedText {
  const storageClass = row[`${prefix}_type`]
  if (storageClass !== 'null' && storageClass !== 'text') {
    throw new ProductStoreError('corrupt_data', `${name} storage class must be text or null`)
  }
  const overflowed = booleanSentinel(row[`${prefix}_overflow`], `${name}_overflow`)
  if (storageClass === 'null') return { value: null, truncated: overflowed }
  const bytes = blobBytes(row[`${prefix}_blob`], name)
  if (bytes === null) return { value: null, truncated: true }
  const decoded = decodeUtf8Prefix(bytes, name)
  if (decoded.clippedTerminalBytes && !overflowed) throw new ProductStoreError('corrupt_data', `${name} is not valid UTF-8 text`)
  const normalized = normalizeAndTruncateProviderEmail(decoded.value, EMAIL_BYTES)
  const valid = normalized.value !== null && validMailAddress(normalized.value) ? normalized.value : null
  return {
    value: valid,
    truncated: overflowed || decoded.clippedTerminalBytes || normalized.truncated || valid === null,
  }
}
function timestampValue(row: Record<string, unknown>, prefix: string): string | null {
  const storageClass = row[`${prefix}_type`]
  if (storageClass !== 'null' && storageClass !== 'text') {
    throw new ProductStoreError('corrupt_data', `${prefix} storage class must be text or null`)
  }
  if (storageClass === 'null') return null
  const value = nullableText(row[`${prefix}_text`], prefix)
  if (value === null || utf8ByteLength(value) > TIMESTAMP_BYTES) {
    throw new ProductStoreError('corrupt_data', `${prefix} must be bounded canonical UTC text or null`)
  }
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?\+00:00$/u.exec(value)
  if (!match) throw new ProductStoreError('corrupt_data', `${prefix} must be canonical UTC text`)
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const instant = new Date(Date.UTC(year!, month! - 1, day, hour, minute, second))
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month! - 1 ||
      instant.getUTCDate() !== day || instant.getUTCHours() !== hour ||
      instant.getUTCMinutes() !== minute || instant.getUTCSeconds() !== second) {
    throw new ProductStoreError('corrupt_data', `${prefix} must be canonical UTC text`)
  }
  return value
}
function boundedBlobSelect(alias: string, column: string, output: string, maxBytes: number, fetchCeilingBytes: number): string {
  return `typeof(${alias}.${column}) AS ${output}_type,
          CASE WHEN typeof(${alias}.${column})='text'
               THEN substr(CAST(${alias}.${column} AS BLOB),1,${fetchCeilingBytes}) ELSE NULL END AS ${output}_blob,
          CASE WHEN ${alias}.${column} IS NOT NULL AND octet_length(${alias}.${column})>${maxBytes} THEN 1 ELSE 0 END AS ${output}_overflow`
}
function boundedTimestampSelect(alias: string, column: string, output: string): string {
  return `typeof(${alias}.${column}) AS ${output}_type,
          CASE WHEN typeof(${alias}.${column})='text' AND octet_length(${alias}.${column})<=${TIMESTAMP_BYTES}
               THEN ${alias}.${column} ELSE NULL END AS ${output}_text`
}
function eligibleSourcesJson(sources: EligibleInboxSource[]): string {
  if (!Array.isArray(sources)) throw new ProductStoreError('invalid_input', 'eligible inbox sources are required')
  const seen = new Set<number>()
  return JSON.stringify(sources.map((source) => {
    if (!source || !Number.isSafeInteger(source.sourceId) || source.sourceId <= 0 || seen.has(source.sourceId)) {
      throw new ProductStoreError('invalid_input', 'eligible source ids must be unique positive safe integers')
    }
    seen.add(source.sourceId)
    if (!Array.isArray(source.identities) || source.identities.length === 0) {
      throw new ProductStoreError('invalid_input', 'each eligible source requires at least one authorized identity')
    }
    return { sourceId: source.sourceId }
  }).sort((left, right) => left.sourceId - right.sourceId))
}

interface HeaderRow extends Record<string, unknown> {}
interface CandidateRow extends Record<string, unknown> {}
export interface ThreadDetailProjectionHooks {
  /** Deterministic WAL-race seam after selected-row authority has been read. */
  afterSelectedRead?: () => void
}

function decodeSubject(row: HeaderRow): { value: string; truncated: boolean } {
  const normalized = boundedProviderText(row, 'subject', 'subject', SUBJECT_BYTES)
  const fallback = normalized.value?.trim() ? normalized.value : EMPTY_DETAIL_SUBJECT
  return { value: fallback, truncated: normalized.truncated }
}
function decodeSender(row: HeaderRow): { value: UnifiedThreadMessage['sender']; truncated: boolean } {
  const name = boundedProviderText(row, 'sender_name', 'sender_name', NAME_BYTES)
  const email = boundedProviderEmail(row, 'sender_email', 'sender_email')
  return {
    value: { name: name.value?.trim() ? name.value : null, email: email.value?.trim() ? email.value : null },
    truncated: name.truncated || email.truncated,
  }
}
function headerSql(): string {
  return `SELECT m.id,
          ${boundedTimestampSelect('m', 'sent_at', 'sent_at')},
          ${boundedBlobSelect('m', 'subject', 'subject', SUBJECT_BYTES, SUBJECT_FETCH_BYTES)},
          ${boundedBlobSelect('sender', 'display_name', 'sender_name', NAME_BYTES, NAME_FETCH_BYTES)},
          ${boundedBlobSelect('sender', 'email_address', 'sender_email', EMAIL_BYTES, EMAIL_FETCH_BYTES)}
        FROM messages m
        LEFT JOIN participants sender ON sender.id=m.sender_id
       WHERE m.id=? AND m.conversation_id=? AND m.source_id=?
         AND m.message_type='email' AND m.deleted_at IS NULL AND m.deleted_from_source_at IS NULL`
}

function selectedSql(): string {
  return `WITH eligible_sources AS NOT MATERIALIZED (
      SELECT CAST(json_extract(value,'$.sourceId') AS INTEGER) AS source_id FROM json_each(?)
    )
    SELECT m.id,m.conversation_id,m.source_id,
           ${boundedTimestampSelect('m', 'sent_at', 'sent_at')},
           ${boundedBlobSelect('m', 'subject', 'subject', SUBJECT_BYTES, SUBJECT_FETCH_BYTES)},
           ${boundedBlobSelect('sender', 'display_name', 'sender_name', NAME_BYTES, NAME_FETCH_BYTES)},
           ${boundedBlobSelect('sender', 'email_address', 'sender_email', EMAIL_BYTES, EMAIL_FETCH_BYTES)}
      FROM messages m
      JOIN conversations c ON c.id=m.conversation_id AND c.source_id=m.source_id
      JOIN eligible_sources source ON source.source_id=m.source_id
      LEFT JOIN participants sender ON sender.id=m.sender_id
     WHERE m.id=? AND m.message_type='email' AND c.conversation_type='email_thread'
       AND m.deleted_at IS NULL AND m.deleted_from_source_at IS NULL`
}

function candidateSql(conversationIndex: string): string {
  return `SELECT m.id,m.source_id,
          m.deleted_at IS NULL AS live_local,
          m.deleted_from_source_at IS NULL AS live_source,
          typeof(m.message_type) AS message_type_type,
          CASE WHEN typeof(m.message_type)='text' AND octet_length(m.message_type)<=${TYPE_FETCH_BYTES}
               THEN m.message_type ELSE NULL END AS message_type_text,
          ${boundedTimestampSelect('m', 'sent_at', 'sent_at')}
        FROM messages m INDEXED BY ${quotedSqlIdentifier(conversationIndex)}
       WHERE m.conversation_id=?
       ORDER BY m.sent_at DESC,m.id ASC
       LIMIT ${CANDIDATE_LIMIT}`
}

function bodySql(): string {
  return `SELECT typeof(body_text) AS body_type,
          CASE WHEN typeof(body_text)='text'
               THEN substr(CAST(body_text AS BLOB),1,${BODY_FETCH_BYTES}) ELSE NULL END AS body_blob,
          CASE WHEN body_text IS NOT NULL AND octet_length(body_text)>${BODY_PER_MESSAGE_BYTES} THEN 1 ELSE 0 END AS body_overflow
      FROM message_bodies WHERE message_id=?`
}
function recipientSql(recipientIndex: string): string {
  return `SELECT ${boundedBlobSelect('r', 'recipient_type', 'recipient_type', TYPE_BYTES, TYPE_FETCH_BYTES)},
          ${boundedBlobSelect('r', 'display_name', 'recipient_name', NAME_BYTES, NAME_FETCH_BYTES)},
          ${boundedBlobSelect('r', 'email_address', 'recipient_email', EMAIL_BYTES, EMAIL_FETCH_BYTES)}
      FROM message_recipients r INDEXED BY ${quotedSqlIdentifier(recipientIndex)}
     WHERE r.message_id=? ORDER BY r.id ASC LIMIT ${METADATA_QUERY_LIMIT}`
}
function attachmentSql(attachmentIndex: string): string {
  return `SELECT typeof(size) AS size_type,
          CASE WHEN typeof(size)='integer' AND size BETWEEN 0 AND ${SQLITE_MAX_SAFE_INTEGER} THEN size ELSE NULL END AS size_safe,
          CASE WHEN size IS NOT NULL AND (typeof(size)!='integer' OR size<0 OR size>${SQLITE_MAX_SAFE_INTEGER}) THEN 1 ELSE 0 END AS size_invalid,
          ${boundedBlobSelect('a', 'filename', 'filename', FILENAME_BYTES, FILENAME_FETCH_BYTES)},
          ${boundedBlobSelect('a', 'mime_type', 'mime_type', MIME_BYTES, MIME_FETCH_BYTES)}
      FROM attachments a INDEXED BY ${quotedSqlIdentifier(attachmentIndex)}
     WHERE a.message_id=? ORDER BY a.id ASC LIMIT ${METADATA_QUERY_LIMIT}`
}

function decodeBody(row: Record<string, unknown> | undefined): { text: string; unavailable: boolean; truncated: boolean } {
  if (!row || row.body_type === 'null') return { text: '', unavailable: true, truncated: false }
  if (row.body_type !== 'text') throw new ProductStoreError('corrupt_data', 'body_text storage class must be text or null')
  const overflowed = booleanSentinel(row.body_overflow, 'body_overflow')
  const bytes = blobBytes(row.body_blob, 'body_text')
  if (bytes === null) return { text: '', unavailable: false, truncated: true }
  const decoded = decodeUtf8Prefix(bytes, 'body_text')
  if (decoded.clippedTerminalBytes && !overflowed) throw new ProductStoreError('corrupt_data', 'body_text is not valid UTF-8 text')
  const normalized = normalizeAndTruncateProviderText(decoded.value, BODY_PER_MESSAGE_BYTES)
  return { text: normalized.value, unavailable: false, truncated: overflowed || decoded.clippedTerminalBytes || normalized.truncated }
}
function decodeRecipients(rows: Record<string, unknown>[]): { recipients: UnifiedThreadRecipient[]; truncated: boolean } {
  let truncated = rows.length > PER_MESSAGE_METADATA_LIMIT
  const recipients: UnifiedThreadRecipient[] = []
  for (const row of rows.slice(0, PER_MESSAGE_METADATA_LIMIT)) {
    const typeField = boundedProviderText(row, 'recipient_type', 'recipient_type', TYPE_BYTES)
    const type = typeField.value?.trim().toLowerCase()
    if (type !== 'to' && type !== 'cc' && type !== 'bcc') { truncated = true; continue }
    const emailField = boundedProviderEmail(row, 'recipient_email', 'recipient_email')
    if (emailField.value === null) { truncated = true; continue }
    const nameField = boundedProviderText(row, 'recipient_name', 'recipient_name', NAME_BYTES)
    recipients.push({
      type,
      name: nameField.value?.trim() ? nameField.value : null,
      email: emailField.value,
    })
    truncated = truncated || typeField.truncated || emailField.truncated || nameField.truncated
  }
  recipients.sort((left, right) => {
    const typeOrder = { to: 0, cc: 1, bcc: 2 } as const
    // Rows entered this array in id ASC order; stable sort keeps id order within each type.
    return typeOrder[left.type] - typeOrder[right.type]
  })
  return { recipients, truncated }
}
function decodeAttachments(rows: Record<string, unknown>[]): { attachments: UnifiedThreadAttachment[]; truncated: boolean } {
  let truncated = rows.length > PER_MESSAGE_METADATA_LIMIT
  const attachments: UnifiedThreadAttachment[] = []
  for (const row of rows.slice(0, PER_MESSAGE_METADATA_LIMIT)) {
    const filename = boundedProviderText(row, 'filename', 'filename', FILENAME_BYTES)
    const mimeType = boundedProviderText(row, 'mime_type', 'mime_type', MIME_BYTES)
    let byteSize: number | null
    if (row.size_type === 'null') byteSize = null
    else if (row.size_type === 'integer') {
      byteSize = Number.isSafeInteger(row.size_safe) && Number(row.size_safe) >= 0 ? row.size_safe as number : null
      if (booleanSentinel(row.size_invalid, 'attachment_size_invalid')) truncated = true
    } else {
      throw new ProductStoreError('corrupt_data', 'attachment size storage class must be integer or null')
    }
    attachments.push({
      filename: filename.value?.trim() ? filename.value : null,
      mimeType: mimeType.value?.trim() ? mimeType.value : null,
      byteSize,
    })
    truncated = truncated || filename.truncated || mimeType.truncated
  }
  return { attachments, truncated }
}

function allocateBodies(messages: UnifiedThreadMessage[]): void {
  const selected = messages.find((message) => message.selected)
  let remaining = BODY_TOTAL_BYTES
  if (selected) {
    const selectedLimit = Math.min(BODY_SELECTED_RESERVE_BYTES, remaining)
    const trimmed = truncateUtf8(selected.bodyText, selectedLimit)
    selected.bodyText = trimmed.value
    selected.bodyTruncated = selected.bodyTruncated || trimmed.truncated
    remaining -= utf8ByteLength(selected.bodyText)
  }
  const newestFirst = messages.filter((message) => !message.selected).sort((left, right) =>
    compareMessageSort(right, left))
  for (const message of newestFirst) {
    const allowance = Math.min(BODY_PER_MESSAGE_BYTES, remaining)
    const trimmed = truncateUtf8(message.bodyText, allowance)
    message.bodyText = trimmed.value
    message.bodyTruncated = message.bodyTruncated || trimmed.truncated || allowance === 0
    remaining -= utf8ByteLength(message.bodyText)
  }
}
function allocateMetadata(messages: UnifiedThreadMessage[]): void {
  let recipientsRemaining = RECIPIENT_GLOBAL_LIMIT
  let attachmentsRemaining = ATTACHMENT_GLOBAL_LIMIT
  const ordered = [
    ...messages.filter((message) => message.selected),
    ...messages.filter((message) => !message.selected).sort((left, right) => compareMessageSort(right, left)),
  ]
  for (const message of ordered) {
    if (message.recipients.length > recipientsRemaining) {
      message.recipients = message.recipients.slice(0, Math.max(0, recipientsRemaining))
      message.metadataTruncated = true
    }
    recipientsRemaining -= message.recipients.length
    if (message.attachments.length > attachmentsRemaining) {
      message.attachments = message.attachments.slice(0, Math.max(0, attachmentsRemaining))
      message.metadataTruncated = true
    }
    attachmentsRemaining -= message.attachments.length
  }
}
function compareMessageSort(left: Pick<UnifiedThreadMessage, 'sentAt' | 'messageId'>, right: Pick<UnifiedThreadMessage, 'sentAt' | 'messageId'>): number {
  if (left.sentAt === null && right.sentAt !== null) return -1
  if (left.sentAt !== null && right.sentAt === null) return 1
  if (left.sentAt !== right.sentAt) return String(left.sentAt ?? '').localeCompare(String(right.sentAt ?? ''))
  return left.messageId - right.messageId
}

export function explainThreadDetailQueryPlans(db: DatabaseSync, messageId: number, eligibleSources: EligibleInboxSource[]): {
  candidates: string[]
  recipients: string[]
  attachments: string[]
} {
  const capabilities = getMsgvaultIndexCapabilities(db)
  const eligible = eligibleSourcesJson(eligibleSources)
  const selected = db.prepare(selectedSql()).get(eligible, messageId) as HeaderRow | undefined
  const conversationId = selected ? positiveInteger(selected.conversation_id, 'conversation_id') : 1
  const details = (sql: string, ...args: Array<string | number | null>) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: unknown }>).map((row) => {
    if (typeof row.detail !== 'string') throw new ProductStoreError('corrupt_data', 'query plan detail must be text')
    return row.detail
  })
  return {
    candidates: details(candidateSql(capabilities.conversation), conversationId),
    recipients: details(recipientSql(capabilities.recipientsByMessage), messageId),
    attachments: details(attachmentSql(capabilities.attachmentsByMessage), messageId),
  }
}

export function getUnifiedThreadInSnapshot(
  db: DatabaseSync,
  eligibleSources: EligibleInboxSource[],
  input: { messageId: number },
  hooks: ThreadDetailProjectionHooks = {},
): UnifiedThreadDetail | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
      Object.keys(input).some((key) => key !== 'messageId')) {
    throw new ProductStoreError('invalid_input', 'thread detail input must be { messageId }')
  }
  const messageId = positiveInput(input.messageId)
  const capabilities = getMsgvaultIndexCapabilities(db)
  const selected = db.prepare(selectedSql()).get(eligibleSourcesJson(eligibleSources), messageId) as HeaderRow | undefined
  if (!selected) return null
  const selectedId = positiveInteger(selected.id, 'selected message id')
  const conversationId = positiveInteger(selected.conversation_id, 'conversation_id')
  const sourceId = positiveInteger(selected.source_id, 'source_id')
  const selectedSubject = decodeSubject(selected)
  if (hooks.afterSelectedRead !== undefined && typeof hooks.afterSelectedRead !== 'function') {
    throw new ProductStoreError('invalid_input', 'afterSelectedRead hook must be a function')
  }
  hooks.afterSelectedRead?.()

  const candidateRows = db.prepare(candidateSql(capabilities.conversation)).all(conversationId) as CandidateRow[]
  const hasRow501 = candidateRows.length > 500
  const inspected: Array<{ id: number; sentAt: string | null }> = []
  for (const row of candidateRows.slice(0, 500)) {
    const id = positiveInteger(row.id, 'candidate message id')
    const rowSourceId = positiveInteger(row.source_id, 'candidate source id')
    if (rowSourceId !== sourceId) continue
    if (row.live_local !== 1 || row.live_source !== 1) continue
    if (row.message_type_type !== 'text') {
      throw new ProductStoreError('corrupt_data', 'candidate message_type storage class must be text')
    }
    const messageType = nullableText(row.message_type_text, 'candidate message_type')
    if (messageType !== 'email') continue
    inspected.push({ id, sentAt: timestampValue(row, 'sent_at') })
  }
  const recentWindow = inspected.slice(0, RECENT_WINDOW)
  const selectedInRecent = recentWindow.some((row) => row.id === selectedId)
  const retainedIds = selectedInRecent
    ? recentWindow.map((row) => row.id)
    : [...recentWindow.slice(0, MAX_MESSAGES - 1).map((row) => row.id), selectedId]
  const uniqueRetainedIds = [...new Set(retainedIds)]
  if (!uniqueRetainedIds.includes(selectedId)) uniqueRetainedIds.push(selectedId)

  const headerStatement = db.prepare(headerSql())
  const bodyStatement = db.prepare(bodySql())
  const recipientStatement = db.prepare(recipientSql(capabilities.recipientsByMessage))
  const attachmentStatement = db.prepare(attachmentSql(capabilities.attachmentsByMessage))
  const messages: UnifiedThreadMessage[] = []
  for (const id of uniqueRetainedIds) {
    const header = headerStatement.get(id, conversationId, sourceId) as HeaderRow | undefined
    if (!header) {
      if (id === selectedId) throw new ProductStoreError('corrupt_data', 'selected message disappeared inside read snapshot')
      continue
    }
    const sentAt = timestampValue(header, 'sent_at')
    const sender = decodeSender(header)
    const body = decodeBody(bodyStatement.get(id) as Record<string, unknown> | undefined)
    const recipients = decodeRecipients(recipientStatement.all(id) as Record<string, unknown>[])
    const attachments = decodeAttachments(attachmentStatement.all(id) as Record<string, unknown>[])
    messages.push({
      messageId: id,
      selected: id === selectedId,
      sentAt,
      sender: sender.value,
      recipients: recipients.recipients,
      bodyText: body.text,
      bodyUnavailable: body.unavailable,
      bodyTruncated: body.truncated,
      attachments: attachments.attachments,
      metadataTruncated: sender.truncated || recipients.truncated || attachments.truncated,
    })
  }
  if (!messages.some((message) => message.selected)) {
    throw new ProductStoreError('corrupt_data', 'selected message was not retained')
  }
  messages.sort(compareMessageSort)
  allocateBodies(messages)
  allocateMetadata(messages)

  const historyTruncated = hasRow501 || inspected.length > messages.length || !selectedInRecent
  return {
    selectedMessageId: selectedId,
    subject: selectedSubject.value,
    messages,
    historyTruncated,
    selectedOutsideRecentWindow: !selectedInRecent,
    replyCapability: { allowed: false, reason: 'drafts_not_in_scope' },
  }
}
