/**
 * Schema-bound unified-inbox projection for msgvault v0.19.
 * This module and its parent adapter are the only boring-mail modules allowed
 * to know msgvault table/index details. It remains internal; public reads cross
 * the async MailStore storage-process boundary.
 */
import { createHmac, type BinaryLike } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  ProductStoreError,
  type UnifiedInboxItem,
  type UnifiedInboxOptions,
  type UnifiedInboxPage,
} from '../product/types.js'
import { normalizeAndTruncateProviderEmail, normalizeAndTruncateProviderText } from '../../shared/textBounds.js'

/** @internal Product-owned source eligibility supplied to the adapter worker. */
export interface EligibleInboxSource {
  sourceId: number
  identities: string[]
}

/** @internal Per-storage-process cursor generation; never crosses RPC. */
export interface UnifiedInboxCursorAuthority {
  scope: string
  /** Process-secret key shared with product read-catalog generation. */
  digestKey: BinaryLike
  /** Deterministic race seam used only by adapter tests. */
  beforePageQuery?: () => void
}

export interface MsgvaultIndexCapabilities {
  rfc822: string
  liveRecency: string
  bySource: string
  conversation: string
  recipientsByMessage: string
  attachmentsByMessage: string
}
const indexCapabilities = new WeakMap<DatabaseSync, MsgvaultIndexCapabilities>()

export function quotedSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
function quotedIdentifier(value: string): string {
  return quotedSqlIdentifier(value)
}
interface IndexListRow { name: string; unique: number; origin: string; partial: number }
interface IndexXInfoRow { seqno: number; cid: number; name: string | null; desc: number; coll: string; key: number }
interface ExpectedIndexColumn { cid: number; name: string | null; desc: 0 | 1; coll: 'BINARY'; key: 0 | 1 }
function indexShape(db: DatabaseSync, name: string): ExpectedIndexColumn[] {
  return (db.prepare(`PRAGMA index_xinfo(${quotedIdentifier(name)})`).all() as unknown as IndexXInfoRow[])
    .sort((left, right) => left.seqno - right.seqno)
    .map((column) => ({
      cid: column.cid,
      name: column.name,
      desc: column.desc as 0 | 1,
      coll: column.coll as 'BINARY',
      key: column.key as 0 | 1,
    }))
}
function findIndex(
  indexes: IndexListRow[],
  db: DatabaseSync,
  spec: { unique: 0 | 1; origin: 'c'; partial: 0 | 1; shape: ExpectedIndexColumn[] },
): string | null {
  const found = indexes.find((index) => index.unique === spec.unique && index.origin === spec.origin &&
    index.partial === spec.partial && JSON.stringify(indexShape(db, index.name)) === JSON.stringify(spec.shape))
  return found?.name ?? null
}

export function inspectIndexCapabilities(db: DatabaseSync): {
  value: MsgvaultIndexCapabilities | null
  errors: string[]
} {
  const messageIndexes = db.prepare(`PRAGMA index_list(messages)`).all() as unknown as IndexListRow[]
  const recipientIndexes = db.prepare(`PRAGMA index_list(message_recipients)`).all() as unknown as IndexListRow[]
  const attachmentIndexes = db.prepare(`PRAGMA index_list(attachments)`).all() as unknown as IndexListRow[]
  const rfc822 = findIndex(messageIndexes, db, {
    unique: 0, origin: 'c', partial: 0, shape: [
      { cid: 4, name: 'rfc822_message_id', desc: 0, coll: 'BINARY', key: 1 },
      { cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
    ],
  })
  const bySource = findIndex(messageIndexes, db, {
    unique: 0, origin: 'c', partial: 0, shape: [
      { cid: 2, name: 'source_id', desc: 0, coll: 'BINARY', key: 1 },
      { cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
    ],
  })
  const conversation = findIndex(messageIndexes, db, {
    unique: 0, origin: 'c', partial: 0, shape: [
      { cid: 1, name: 'conversation_id', desc: 0, coll: 'BINARY', key: 1 },
      { cid: 6, name: 'sent_at', desc: 1, coll: 'BINARY', key: 1 },
      { cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
    ],
  })
  const recipientsByMessage = findIndex(recipientIndexes, db, {
    unique: 0, origin: 'c', partial: 0, shape: [
      { cid: 1, name: 'message_id', desc: 0, coll: 'BINARY', key: 1 },
      { cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
    ],
  })
  const attachmentsByMessage = findIndex(attachmentIndexes, db, {
    unique: 0, origin: 'c', partial: 0, shape: [
      { cid: 1, name: 'message_id', desc: 0, coll: 'BINARY', key: 1 },
      { cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
    ],
  })
  const liveRecency = findIndex(messageIndexes, db, {
    unique: 0,
    origin: 'c',
    partial: 1,
    shape: [
      { cid: -2, name: null, desc: 1, coll: 'BINARY', key: 1 },
      { cid: 0, name: 'id', desc: 1, coll: 'BINARY', key: 1 },
      { cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
    ],
  })
  const indexSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
  const liveSql = liveRecency
    ? (indexSql.get(liveRecency) as { sql: string | null } | undefined)?.sql
      ?.toLowerCase().replace(/["`\[\]]/g, '').replace(/\s+/g, '') ?? ''
    : ''
  const liveRecencyValid = !!liveRecency &&
    /^createindex.+onmessages\(coalesce\(sent_at,received_at,internal_date\)desc,iddesc\)wheredeleted_atisnullanddeleted_from_source_atisnull$/.test(liveSql)
  const errors = [
    !rfc822 ? 'messages requires a non-unique, non-partial ASC index exactly on rfc822_message_id' : '',
    !liveRecencyValid
      ? 'messages requires a non-unique partial DESC index on COALESCE(sent_at,received_at,internal_date),id for live rows'
      : '',
    !bySource ? 'messages requires a non-unique, non-partial ASC index exactly on source_id' : '',
    !conversation ? 'messages requires a non-unique, non-partial index exactly on conversation_id ASC,sent_at DESC' : '',
    !recipientsByMessage
      ? 'message_recipients requires a non-unique, non-partial ASC index exactly on message_id'
      : '',
    !attachmentsByMessage
      ? 'attachments requires a non-unique, non-partial ASC index exactly on message_id'
      : '',
  ].filter(Boolean)
  return {
    value: rfc822 && liveRecencyValid && bySource && conversation && recipientsByMessage && attachmentsByMessage
      ? { rfc822, liveRecency: liveRecency!, bySource, conversation, recipientsByMessage, attachmentsByMessage }
      : null,
    errors,
  }
}

export function rememberIndexCapabilities(db: DatabaseSync, value: MsgvaultIndexCapabilities): void {
  indexCapabilities.set(db, value)
}

const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
/** Conservative printable-ASCII dot-atom contract for correlation and replies. */
export function correlatableMessageId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 5 || value.length > 998 ||
      value[0] !== '<' || value.at(-1) !== '>' || /[^\x21-\x7e]/.test(value)) return null
  const inner = value.slice(1, -1)
  const at = inner.indexOf('@')
  if (at <= 0 || at !== inner.lastIndexOf('@') || at === inner.length - 1) return null
  const local = inner.slice(0, at)
  const domain = inner.slice(at + 1)
  const localParts = local.split('.')
  const domainParts = domain.split('.')
  if (localParts.some((part) => !part || !DOT_ATOM.test(part)) ||
      domainParts.some((part) => !part || part.length > 63 || !DOMAIN_LABEL.test(part))) return null
  return value
}

const UNIFIED_INBOX_MAX_LIMIT = 50
const MAX_CURSOR_LENGTH = 2_048
const SENDER_NAME_BYTES = 512
const SENDER_EMAIL_BYTES = 320
const SUBJECT_BYTES = 1_024
const SNIPPET_BYTES = 2_048
const SENDER_NAME_PREFIX_BYTES = SENDER_NAME_BYTES + 4
const SENDER_EMAIL_PREFIX_BYTES = SENDER_EMAIL_BYTES + 4
const SUBJECT_PREFIX_BYTES = SUBJECT_BYTES + 4
const SNIPPET_PREFIX_BYTES = SNIPPET_BYTES + 4
const EXPLAIN_DIGEST_KEY = Buffer.alloc(32, 0)
const RFC822_MESSAGE_ID_BYTES = 998

interface UnifiedCursorPayload {
  v: 1
  s: string
  d: number
  e: string
  t: string | null
  i: number
}

function boundedLimit(value: number | undefined): number {
  const selected = value ?? 30
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > UNIFIED_INBOX_MAX_LIMIT) {
    throw new ProductStoreError(
      'invalid_input',
      `limit must be a safe integer between 1 and ${UNIFIED_INBOX_MAX_LIMIT}`,
    )
  }
  return selected
}
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ProductStoreError('corrupt_data', `${name} must be a positive safe integer`)
  }
  return value as number
}
function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new ProductStoreError('corrupt_data', `${name} must be text or null`)
  return value
}
function booleanInteger(value: unknown, name: string): boolean {
  if (value !== 0 && value !== 1) throw new ProductStoreError('corrupt_data', `${name} must be 0 or 1`)
  return value === 1
}
function booleanSentinel(value: unknown, name: string): boolean {
  if (value === null || value === undefined) return false
  return booleanInteger(value, name)
}
function blobBytes(value: unknown, name: string): Uint8Array | null {
  if (value === null) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return value
  throw new ProductStoreError('corrupt_data', `${name} bounded prefix must be bytes or null`)
}
function decodeUtf8Prefix(bytes: Uint8Array, name: string): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = bytes.length; end >= 0; end--) {
    try { return decoder.decode(bytes.subarray(0, end)) }
    catch {
      if (end === 0) throw new ProductStoreError('corrupt_data', `${name} is not valid UTF-8 text`)
    }
  }
  return ''
}
function boundedTextField(value: unknown, storageClass: unknown, overflow: unknown, name: string, maxBytes: number): { value: string | null; truncated: boolean } {
  if (storageClass !== 'null' && storageClass !== 'text') {
    throw new ProductStoreError('corrupt_data', `${name} storage class must be text or null`)
  }
  const bytes = blobBytes(value, name)
  if (storageClass === 'null') {
    if (bytes !== null) throw new ProductStoreError('corrupt_data', `${name} null storage carried bytes`)
    return { value: null, truncated: booleanSentinel(overflow, `${name}_overflow`) }
  }
  const overflowed = booleanSentinel(overflow, `${name}_overflow`)
  if (bytes === null) {
    if (overflowed) return { value: null, truncated: true }
    throw new ProductStoreError('corrupt_data', `${name} text storage missing bytes`)
  }
  const normalized = normalizeAndTruncateProviderText(decodeUtf8Prefix(bytes, name), maxBytes)
  return { value: normalized.value, truncated: overflowed || normalized.truncated }
}
function boundedEmailField(value: unknown, storageClass: unknown, overflow: unknown, name: string, maxBytes: number): { value: string | null; truncated: boolean } {
  if (storageClass !== 'null' && storageClass !== 'text') {
    throw new ProductStoreError('corrupt_data', `${name} storage class must be text or null`)
  }
  if (storageClass === 'null') return { value: null, truncated: booleanSentinel(overflow, `${name}_overflow`) }
  const bytes = blobBytes(value, name)
  const overflowed = booleanSentinel(overflow, `${name}_overflow`)
  if (bytes === null) {
    if (overflowed) return { value: null, truncated: true }
    throw new ProductStoreError('corrupt_data', `${name} text storage missing bytes`)
  }
  const normalized = normalizeAndTruncateProviderEmail(decodeUtf8Prefix(bytes, name), maxBytes)
  return { value: normalized.value, truncated: overflowed || normalized.truncated }
}
function dataVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA data_version').get() as { data_version?: unknown }
  return positiveInteger(row.data_version, 'msgvault data_version')
}
export function eligibleSourceGeneration(
  sources: EligibleInboxSource[],
  authority: Pick<UnifiedInboxCursorAuthority, 'digestKey'>,
): string {
  return sourceInput(sources, authority).digest
}

function sourceInput(
  sources: EligibleInboxSource[],
  authority: Pick<UnifiedInboxCursorAuthority, 'digestKey'>,
): { json: string; digest: string } {
  if (!Array.isArray(sources)) throw new ProductStoreError('invalid_input', 'eligible inbox sources are required')
  if (!authority || !authority.digestKey) throw new ProductStoreError('invalid_input', 'cursor authority digest key is required')
  const seen = new Set<number>()
  const normalized = sources.map((source) => {
    if (!source || !Number.isSafeInteger(source.sourceId) || source.sourceId <= 0 || seen.has(source.sourceId)) {
      throw new ProductStoreError('invalid_input', 'eligible source ids must be unique positive safe integers')
    }
    seen.add(source.sourceId)
    if (!Array.isArray(source.identities) || source.identities.length === 0) {
      throw new ProductStoreError('invalid_input', 'each eligible source requires at least one authorized identity')
    }
    const identities = [...new Set(source.identities.map((identity) => {
      if (typeof identity !== 'string' || !identity.trim()) {
        throw new ProductStoreError('invalid_input', 'authorized identities must be non-empty text')
      }
      return identity.trim().toLowerCase()
    }))].sort()
    return { sourceId: source.sourceId, identities }
  }).sort((left, right) => left.sourceId - right.sourceId)
  const json = JSON.stringify(normalized)
  return {
    json,
    digest: createHmac('sha256', authority.digestKey)
      .update('boring-mail.read-source-eligibility.v1\0')
      .update(json)
      .digest('base64url'),
  }
}
function encodeCursor(payload: UnifiedCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}
function readCursor(
  cursor: string,
  authority: UnifiedInboxCursorAuthority,
  expectedDataVersion: number,
  expectedSourceDigest: string,
): UnifiedCursorPayload {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed')
  }
  let decoded: Buffer
  let value: unknown
  try {
    decoded = Buffer.from(cursor, 'base64url')
    if (decoded.toString('base64url') !== cursor) throw new Error('noncanonical base64url')
    value = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed')
  }
  const payload = value as Record<string, unknown>
  const keys = Object.keys(payload).sort()
  if (keys.join(',') !== 'd,e,i,s,t,v' || payload.v !== 1 || typeof payload.s !== 'string' ||
      !Number.isSafeInteger(payload.d) || typeof payload.e !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.e) ||
      (payload.t !== null && typeof payload.t !== 'string') ||
      !Number.isSafeInteger(payload.i) || Number(payload.i) <= 0) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor has an invalid payload')
  }
  const normalized: UnifiedCursorPayload = {
    v: 1,
    s: payload.s,
    d: payload.d as number,
    e: payload.e,
    t: payload.t as string | null,
    i: payload.i as number,
  }
  if (encodeCursor(normalized) !== cursor) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor is not canonical')
  }
  if (normalized.s !== authority.scope || normalized.d !== expectedDataVersion ||
      normalized.e !== expectedSourceDigest) {
    throw new ProductStoreError('stale_cursor', 'unified inbox cursor expired after storage state changed')
  }
  if (normalized.t !== null) canonicalUtcTimestamp(normalized.t, 'cursor timestamp', 'invalid_input')
  return normalized
}
function liveMessage(alias: string): string {
  return `${alias}.deleted_at IS NULL AND ${alias}.deleted_from_source_at IS NULL`
}
function replyableEmail(message: string, conversation: string): string {
  return `${liveMessage(message)} AND ${message}.message_type='email' AND ${conversation}.conversation_type='email_thread'`
}
export function getMsgvaultIndexCapabilities(db: DatabaseSync): MsgvaultIndexCapabilities {
  const capabilities = indexCapabilities.get(db)
  if (!capabilities) {
    throw new ProductStoreError('unsupported_schema', 'msgvault index capabilities are unavailable')
  }
  return capabilities
}
function requireUnifiedCapabilities(db: DatabaseSync): MsgvaultIndexCapabilities {
  return getMsgvaultIndexCapabilities(db)
}
function canonicalUtcTimestamp(
  value: unknown,
  name: string,
  code: 'invalid_input' | 'corrupt_data' = 'corrupt_data',
): string {
  if (typeof value !== 'string') throw new ProductStoreError(code, `${name} must be canonical UTC text`)
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?\+00:00$/.exec(value)
  if (!match) throw new ProductStoreError(code, `${name} must be canonical UTC text`)
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const instant = new Date(Date.UTC(year!, month! - 1, day, hour, minute, second))
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month! - 1 ||
      instant.getUTCDate() !== day || instant.getUTCHours() !== hour ||
      instant.getUTCMinutes() !== minute || instant.getUTCSeconds() !== second) {
    throw new ProductStoreError(code, `${name} must be canonical UTC text`)
  }
  return value
}

function decodeUnifiedInboxItem(row: Record<string, unknown>): UnifiedInboxItem {
  const rfc822 = nullableText(row.valid_rfc822_message_id, 'rfc822_message_id')
  if (rfc822 !== null && correlatableMessageId(rfc822) === null) {
    throw new ProductStoreError('corrupt_data', 'rfc822_message_id violated the correlation contract')
  }
  if (typeof row.source_identifier !== 'string' || !row.source_identifier.trim()) {
    throw new ProductStoreError('corrupt_data', 'source_identifier must be non-empty text')
  }
  const copyCount = positiveInteger(row.copy_count, 'copy_count')
  const attachmentCount = row.attachment_count
  if (!Number.isSafeInteger(attachmentCount) || Number(attachmentCount) < 0) {
    throw new ProductStoreError('corrupt_data', 'attachment_count must be a non-negative safe integer')
  }
  const subject = boundedTextField(row.subject_blob, row.subject_type, row.subject_overflow, 'subject', SUBJECT_BYTES)
  const snippet = boundedTextField(row.snippet_blob, row.snippet_type, row.snippet_overflow, 'snippet', SNIPPET_BYTES)
  const senderName = boundedTextField(row.sender_name_blob, row.sender_name_type, row.sender_name_overflow, 'sender_name', SENDER_NAME_BYTES)
  const senderEmail = boundedEmailField(row.sender_email_blob, row.sender_email_type, row.sender_email_overflow, 'sender_email', SENDER_EMAIL_BYTES)
  return {
    messageId: positiveInteger(row.message_id, 'message_id'),
    conversationId: positiveInteger(row.conversation_id, 'conversation_id'),
    sourceId: positiveInteger(row.source_id, 'source_id'),
    sourceIdentifier: row.source_identifier,
    rfc822MessageId: rfc822,
    subject: subject.value,
    snippet: snippet.value,
    senderName: senderName.value,
    senderEmail: senderEmail.value,
    // msgvault v0.19's validated recency index orders this canonical UTC form.
    messageAt: row.message_at === null ? null : canonicalUtcTimestamp(row.message_at, 'message_at'),
    unread: !booleanInteger(row.is_read, 'is_read'),
    hasAttachments: Number(attachmentCount) > 0,
    coalesced: copyCount > 1,
    copyCount,
    textTruncated: {
      senderName: senderName.truncated,
      senderEmail: senderEmail.truncated,
      subject: subject.truncated,
      snippet: snippet.truncated,
    },
  }
}

/**
 * Adaptive exact page: a bounded recency window serves dense archives; if it
 * cannot produce a full page, its partial rows are discarded and a source-index
 * fallback sorts only connected-source rows. The msgvault DB remains read-only.
 */
type UnifiedKeysetMode = 'all' | 'before-timestamp' | 'all-null' | 'before-null'
export type UnifiedQueryStrategy = 'recent-window' | 'source-fallback'
const MIN_RECENT_SCAN_WINDOW = 2_000
const MAX_RECENT_CORRELATION_COPIES = 64

function boundedBlobSelect(alias: string, column: string, output: string, maxBytes: number, fetchCeilingBytes: number): string {
  return `typeof(${alias}.${column}) AS ${output}_type,
          CASE WHEN typeof(${alias}.${column})='text' AND octet_length(${alias}.${column})<=${fetchCeilingBytes}
               THEN CAST(${alias}.${column} AS BLOB) ELSE NULL END AS ${output}_blob,
          CASE WHEN ${alias}.${column} IS NOT NULL AND octet_length(${alias}.${column})>${maxBytes} THEN 1 ELSE 0 END AS ${output}_overflow`
}
function boundedRfc822(alias: string): string {
  return `CASE WHEN typeof(${alias}.rfc822_message_id)='text'
                 AND octet_length(${alias}.rfc822_message_id)<=${RFC822_MESSAGE_ID_BYTES}
               THEN boring_mail_message_id(${alias}.rfc822_message_id)
               ELSE NULL END`
}

function unifiedInboxSql(
  capabilities: MsgvaultIndexCapabilities,
  mode: UnifiedKeysetMode,
  strategy: UnifiedQueryStrategy,
): string {
  const liveIndex = quotedIdentifier(capabilities.liveRecency)
  const sourceIndex = quotedIdentifier(capabilities.bySource)
  const rfc822Index = quotedIdentifier(capabilities.rfc822)
  const recipientIndex = quotedIdentifier(capabilities.recipientsByMessage)
  const addressed = (message: string, source: string): string => `EXISTS (
    SELECT 1 FROM message_recipients recipient INDEXED BY ${recipientIndex}
    JOIN json_each(${source}.identities_json) identity
      ON lower(trim(recipient.email_address))=identity.value
    WHERE recipient.message_id=${message}.id
      AND lower(recipient.recipient_type) IN ('to','cc','bcc')
  )`
  const timestamp = 'COALESCE(candidate.sent_at,candidate.received_at,candidate.internal_date)'
  const keysetFor = (time: string, id: string): string => mode === 'before-timestamp'
    ? `AND ${time} IS NOT NULL
       AND ${time}<=?
       AND (${time}<? OR ${id}<?)`
    : mode === 'all-null'
      ? `AND ${time} IS NULL`
      : mode === 'before-null'
        ? `AND ${time} IS NULL AND ${id}<?`
        : ''
  const candidateKeyset = keysetFor(timestamp, 'candidate.id')
  const representativeKeyset = keysetFor('ranked.message_at', 'ranked.message_id')
  const eligibleSources = `eligible_sources AS NOT MATERIALIZED (
    SELECT CAST(json_extract(value,'$.sourceId') AS INTEGER) AS source_id,
           json_extract(value,'$.identities') AS identities_json
      FROM json_each(?)
  )`
  const finalTextSelect = `
           ${boundedBlobSelect('message', 'subject', 'subject', SUBJECT_BYTES, SUBJECT_PREFIX_BYTES)},
           ${boundedBlobSelect('message', 'snippet', 'snippet', SNIPPET_BYTES, SNIPPET_PREFIX_BYTES)},
           ${boundedBlobSelect('sender', 'display_name', 'sender_name', SENDER_NAME_BYTES, SENDER_NAME_PREFIX_BYTES)},
           ${boundedBlobSelect('sender', 'email_address', 'sender_email', SENDER_EMAIL_BYTES, SENDER_EMAIL_PREFIX_BYTES)}`

  if (strategy === 'source-fallback') {
    return `
      WITH ${eligibleSources},
      source_candidates AS MATERIALIZED (
        SELECT candidate.id AS message_id,
               candidate.conversation_id,
               candidate.source_id,
               ${boundedRfc822('candidate')} AS valid_rfc822_message_id,
               ${timestamp} AS message_at,
               CASE WHEN ${boundedRfc822('candidate')} IS NULL
                    THEN '#'||candidate.id ELSE ${boundedRfc822('candidate')} END AS correlation_key,
               ${addressed('candidate', 'candidate_source')} AS addressed
          FROM eligible_sources candidate_source
          JOIN messages candidate INDEXED BY ${sourceIndex}
            ON candidate.source_id=candidate_source.source_id
          JOIN conversations conversation
            ON conversation.id=candidate.conversation_id
           AND conversation.source_id=candidate.source_id
         WHERE ${replyableEmail('candidate', 'conversation')}
      ),
      ranked_candidates AS MATERIALIZED (
        SELECT source_candidates.*,
               count(*) OVER (PARTITION BY correlation_key) AS copy_count,
               row_number() OVER (
                 PARTITION BY correlation_key
                 ORDER BY addressed DESC,message_at DESC NULLS LAST,source_id ASC,message_id ASC
               ) AS representative_rank
          FROM source_candidates
      ),
      selected_page AS MATERIALIZED (
        SELECT message_id,conversation_id,source_id,valid_rfc822_message_id,message_at,copy_count
          FROM ranked_candidates ranked
         WHERE representative_rank=1
           ${representativeKeyset}
         ORDER BY message_at DESC NULLS LAST,message_id DESC
         LIMIT ?
      )
      SELECT selected.message_id,
             selected.conversation_id,
             selected.source_id,
             source.identifier AS source_identifier,
             selected.valid_rfc822_message_id,
             ${finalTextSelect},
             selected.message_at,
             message.is_read,
             message.attachment_count,
             selected.copy_count
        FROM selected_page selected
        JOIN messages message ON message.id=selected.message_id
        JOIN sources source ON source.id=selected.source_id
        LEFT JOIN participants sender ON sender.id=message.sender_id
       ORDER BY selected.message_at DESC NULLS LAST,selected.message_id DESC
    `
  }

  return `
    WITH ${eligibleSources},
    recent_rows AS MATERIALIZED (
      SELECT candidate.id,
             candidate.conversation_id,
             candidate.source_id,
             ${boundedRfc822('candidate')} AS valid_rfc822_message_id,
             CASE WHEN ${boundedRfc822('candidate')} IS NULL
                  THEN '#'||candidate.id ELSE ${boundedRfc822('candidate')} END AS correlation_key,
             candidate.message_type,
             candidate.sent_at,
             candidate.received_at,
             candidate.internal_date,
             candidate.deleted_at,
             candidate.deleted_from_source_at
        FROM messages candidate INDEXED BY ${liveIndex}
       WHERE ${liveMessage('candidate')}
         ${candidateKeyset}
       ORDER BY ${timestamp} DESC NULLS LAST,candidate.id DESC
       LIMIT ?
    ),
    recent_candidates AS MATERIALIZED (
      SELECT candidate.id,
             candidate.conversation_id,
             candidate.source_id,
             candidate.valid_rfc822_message_id,
             COALESCE(candidate.sent_at,candidate.received_at,candidate.internal_date) AS message_at,
             candidate.correlation_key
        FROM recent_rows candidate
        JOIN eligible_sources candidate_source ON candidate_source.source_id=candidate.source_id
        JOIN conversations conversation
          ON conversation.id=candidate.conversation_id
         AND conversation.source_id=candidate.source_id
       WHERE ${replyableEmail('candidate', 'conversation')}
    ),
    recent_correlations AS MATERIALIZED (
      SELECT correlation_key,valid_rfc822_message_id,min(id) AS row_id,count(*) AS recent_copy_count
        FROM recent_candidates
       GROUP BY correlation_key,valid_rfc822_message_id
    ),
    recent_safety AS MATERIALIZED (
      SELECT coalesce(max(recent_copy_count),0)<=${MAX_RECENT_CORRELATION_COPIES} AS safe
        FROM recent_correlations
    ),
    selected_correlations AS MATERIALIZED (
      SELECT correlation.correlation_key,
             CASE WHEN safety.safe=0 THEN NULL
                  WHEN correlation.valid_rfc822_message_id IS NULL THEN correlation.row_id ELSE (
               SELECT primary_copy.id
                 FROM messages primary_copy INDEXED BY ${rfc822Index}
                 JOIN eligible_sources primary_source ON primary_source.source_id=primary_copy.source_id
                 JOIN conversations primary_conversation
                   ON primary_conversation.id=primary_copy.conversation_id
                  AND primary_conversation.source_id=primary_copy.source_id
                WHERE primary_copy.rfc822_message_id=correlation.valid_rfc822_message_id
                  AND ${replyableEmail('primary_copy', 'primary_conversation')}
                ORDER BY ${addressed('primary_copy', 'primary_source')} DESC,
                         COALESCE(primary_copy.sent_at,primary_copy.received_at,primary_copy.internal_date) DESC NULLS LAST,
                         primary_copy.source_id ASC,primary_copy.id ASC
                LIMIT 1
             ) END AS message_id,
             CASE WHEN safety.safe=0 THEN 0
                  WHEN correlation.valid_rfc822_message_id IS NULL THEN 1 ELSE (
               SELECT count(*)
                 FROM messages copy INDEXED BY ${rfc822Index}
                 JOIN eligible_sources copy_source ON copy_source.source_id=copy.source_id
                 JOIN conversations copy_conversation
                   ON copy_conversation.id=copy.conversation_id
                  AND copy_conversation.source_id=copy.source_id
                WHERE copy.rfc822_message_id=correlation.valid_rfc822_message_id
                  AND ${replyableEmail('copy', 'copy_conversation')}
             ) END AS copy_count
        FROM recent_correlations correlation
        CROSS JOIN recent_safety safety
       WHERE safety.safe=1
    ),
    selected_page AS MATERIALIZED (
      SELECT candidate.id AS message_id,
             candidate.conversation_id,
             candidate.source_id,
             candidate.valid_rfc822_message_id,
             candidate.message_at,
             selected.copy_count
        FROM selected_correlations selected
        JOIN recent_candidates candidate ON candidate.id=selected.message_id
       ORDER BY candidate.message_at DESC NULLS LAST,candidate.id DESC
       LIMIT ?
    )
    SELECT selected.message_id,
           selected.conversation_id,
           selected.source_id,
           source.identifier AS source_identifier,
           selected.valid_rfc822_message_id,
           ${finalTextSelect},
           selected.message_at,
           message.is_read,
           message.attachment_count,
           selected.copy_count
      FROM selected_page selected
      JOIN messages message ON message.id=selected.message_id
      JOIN sources source ON source.id=selected.source_id
      LEFT JOIN participants sender ON sender.id=message.sender_id
     ORDER BY selected.message_at DESC NULLS LAST,selected.message_id DESC
  `
}

/** @internal Deterministic proof seam for the exact production query. */
export function explainUnifiedInboxQueryPlan(
  db: DatabaseSync,
  eligibleSources: EligibleInboxSource[],
  after?: { messageAt: string | null; messageId: number },
  strategy: UnifiedQueryStrategy = 'recent-window',
): string[] {
  const capabilities = requireUnifiedCapabilities(db)
  const eligible = sourceInput(eligibleSources, { digestKey: EXPLAIN_DIGEST_KEY })
  const mode: UnifiedKeysetMode = !after ? 'all' : after.messageAt === null ? 'before-null' : 'before-timestamp'
  const keysetArgs = !after ? [] : after.messageAt === null
    ? [after.messageId]
    : [after.messageAt, after.messageAt, after.messageId]
  const args = strategy === 'recent-window'
    ? [eligible.json, ...keysetArgs, MIN_RECENT_SCAN_WINDOW, 51]
    : [eligible.json, ...keysetArgs, 51]
  return (db.prepare(`EXPLAIN QUERY PLAN ${unifiedInboxSql(capabilities, mode, strategy)}`).all(
    ...args,
  ) as Array<{ detail: unknown }>).map((row) => {
    if (typeof row.detail !== 'string') {
      throw new ProductStoreError('corrupt_data', 'msgvault query plan detail must be text')
    }
    return row.detail
  })
}

export function currentMsgvaultDataVersion(db: DatabaseSync): number {
  return dataVersion(db)
}

export function listUnifiedInboxInSnapshot(
  db: DatabaseSync,
  eligibleSources: EligibleInboxSource[],
  authority: UnifiedInboxCursorAuthority,
  snapshotDataVersion: number,
  input: UnifiedInboxOptions | undefined = {},
): UnifiedInboxPage {
  if (!authority || typeof authority.scope !== 'string' || !authority.scope ||
      (authority.beforePageQuery !== undefined && typeof authority.beforePageQuery !== 'function')) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor authority is required')
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
      Object.keys(input).some((key) => key !== 'limit' && key !== 'cursor')) {
    throw new ProductStoreError('invalid_input', 'unified inbox options must be a plain options object')
  }
  const opts = input as UnifiedInboxOptions
  const limit = boundedLimit(opts.limit)
  const capabilities = requireUnifiedCapabilities(db)
  const eligible = sourceInput(eligibleSources, authority)
  const cursor = opts.cursor !== undefined
    ? readCursor(opts.cursor, authority, snapshotDataVersion, eligible.digest)
    : null
  if (eligibleSources.length === 0) {
    return { items: [], nextCursor: null }
  }

  authority.beforePageQuery?.()
  const run = (
    mode: UnifiedKeysetMode,
    args: Array<string | number | null>,
    wanted: number,
    strategy: UnifiedQueryStrategy,
  ) => {
    const strategyArgs = strategy === 'recent-window'
      ? [...args, Math.max(MIN_RECENT_SCAN_WINDOW, wanted * 10), wanted]
      : [...args, wanted]
    return db.prepare(unifiedInboxSql(capabilities, mode, strategy)).all(
      eligible.json, ...strategyArgs,
    ) as Array<Record<string, unknown>>
  }
  const adaptive = (mode: UnifiedKeysetMode, args: Array<string | number | null>, wanted: number) => {
    const recent = run(mode, args, wanted, 'recent-window')
    return recent.length >= wanted
      ? { rows: recent, strategy: 'recent-window' as const }
      : { rows: run(mode, args, wanted, 'source-fallback'), strategy: 'source-fallback' as const }
  }
  const wanted = limit + 1
  let selected: { rows: Array<Record<string, unknown>>; strategy: UnifiedQueryStrategy }
  if (!cursor) {
    selected = adaptive('all', [], wanted)
  } else if (cursor.t === null) {
    selected = adaptive('before-null', [cursor.i], wanted)
  } else {
    selected = adaptive('before-timestamp', [cursor.t, cursor.t, cursor.i], wanted)
    if (selected.rows.length < wanted) {
      // A timestamp-phase shortfall must have discarded the recent window.
      if (selected.strategy !== 'source-fallback') {
        throw new ProductStoreError('corrupt_data', 'unified inbox adaptive strategy violated its exactness invariant')
      }
      selected.rows.push(...run('all-null', [], wanted - selected.rows.length, selected.strategy))
    }
  }
  const rows = selected.rows
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(decodeUnifiedInboxItem)
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last
      ? encodeCursor({
          v: 1,
          s: authority.scope,
          d: snapshotDataVersion,
          e: eligible.digest,
          t: last.messageAt,
          i: last.messageId,
        })
      : null,
  }
}

export function listUnifiedInbox(
  db: DatabaseSync,
  eligibleSources: EligibleInboxSource[],
  authority: UnifiedInboxCursorAuthority,
  input: UnifiedInboxOptions | undefined = {},
): UnifiedInboxPage {
  db.exec('BEGIN DEFERRED')
  try {
    const version = dataVersion(db)
    const page = listUnifiedInboxInSnapshot(db, eligibleSources, authority, version, input)
    db.exec('COMMIT')
    if (dataVersion(db) !== version) {
      throw new ProductStoreError('stale_cursor', 'msgvault changed while reading a unified inbox page')
    }
    return page
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    throw error
  }
}
