/**
 * Schema-bound unified-inbox projection for msgvault v0.19.
 * This module and its parent adapter are the only boring-mail modules allowed
 * to know msgvault table/index details. It remains internal; public reads cross
 * the async MailStore storage-process boundary.
 */
import { createHash } from 'node:crypto'
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
  /** Deterministic race seam used only by adapter tests. */
  beforePageQuery?: () => void
}

interface MsgvaultIndexCapabilities {
  rfc822: string
  liveRecency: string
  bySource: string
  recipientsByMessage: string
}
const indexCapabilities = new WeakMap<DatabaseSync, MsgvaultIndexCapabilities>()

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
function indexColumns(db: DatabaseSync, name: string): Array<{ name: string | null }> {
  return db.prepare(`PRAGMA index_info(${quotedIdentifier(name)})`).all() as Array<{ name: string | null }>
}
export function inspectIndexCapabilities(db: DatabaseSync): {
  value: MsgvaultIndexCapabilities | null
  errors: string[]
} {
  type IndexRow = { name: string; unique: number; partial: number }
  const messageIndexes = db.prepare(`PRAGMA index_list(messages)`).all() as IndexRow[]
  const recipientIndexes = db.prepare(`PRAGMA index_list(message_recipients)`).all() as IndexRow[]
  const rfc822 = messageIndexes.find((index) => index.unique === 0 && index.partial === 0 &&
    indexColumns(db, index.name)[0]?.name === 'rfc822_message_id')
  const bySource = messageIndexes.find((index) => index.unique === 0 && index.partial === 0 &&
    indexColumns(db, index.name)[0]?.name === 'source_id')
  const recipientsByMessage = recipientIndexes.find((index) => index.partial === 0 &&
    indexColumns(db, index.name)[0]?.name === 'message_id')
  const indexSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
  const liveRecency = messageIndexes.find((index) => {
    if (index.unique !== 0 || index.partial !== 1) return false
    const columns = indexColumns(db, index.name)
    if (columns[0]?.name !== null || columns[1]?.name !== 'id' || columns.length !== 2) return false
    const sql = (indexSql.get(index.name) as { sql: string | null } | undefined)?.sql
      ?.toLowerCase().replace(/["`\[\]]/g, '').replace(/\s+/g, '') ?? ''
    return /^createindex.+onmessages\(coalesce\(sent_at,received_at,internal_date\)desc,iddesc\)wheredeleted_atisnullanddeleted_from_source_atisnull$/.test(sql)
  })
  const errors = [
    !rfc822 ? 'messages requires a non-unique, non-partial index led by rfc822_message_id' : '',
    !liveRecency
      ? 'messages requires a live recency index on COALESCE(sent_at,received_at,internal_date) DESC,id DESC'
      : '',
    !bySource ? 'messages requires a non-partial index led by source_id' : '',
    !recipientsByMessage
      ? 'message_recipients requires a non-partial index led by message_id'
      : '',
  ].filter(Boolean)
  return {
    value: rfc822 && liveRecency && bySource && recipientsByMessage
      ? {
          rfc822: rfc822.name,
          liveRecency: liveRecency.name,
          bySource: bySource.name,
          recipientsByMessage: recipientsByMessage.name,
        }
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
const SENDER_NAME_PREFIX_CHARS = SENDER_NAME_BYTES + 1
const SENDER_EMAIL_PREFIX_CHARS = SENDER_EMAIL_BYTES + 1
const SUBJECT_PREFIX_CHARS = SUBJECT_BYTES + 1
const SNIPPET_PREFIX_CHARS = SNIPPET_BYTES + 1

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
function boundedTextField(value: unknown, overflow: unknown, name: string, maxBytes: number): { value: string | null; truncated: boolean } {
  const text = nullableText(value, name)
  if (text === null) return { value: null, truncated: booleanSentinel(overflow, `${name}_overflow`) }
  const normalized = normalizeAndTruncateProviderText(text, maxBytes)
  return { value: normalized.value, truncated: booleanSentinel(overflow, `${name}_overflow`) || normalized.truncated }
}
function boundedEmailField(value: unknown, overflow: unknown, name: string, maxBytes: number): { value: string | null; truncated: boolean } {
  const text = nullableText(value, name)
  const normalized = normalizeAndTruncateProviderEmail(text, maxBytes)
  return { value: normalized.value, truncated: booleanSentinel(overflow, `${name}_overflow`) || normalized.truncated }
}
function dataVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA data_version').get() as { data_version?: unknown }
  return positiveInteger(row.data_version, 'msgvault data_version')
}
function sourceInput(sources: EligibleInboxSource[]): { json: string; digest: string } {
  if (!Array.isArray(sources)) throw new ProductStoreError('invalid_input', 'eligible inbox sources are required')
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
  return { json, digest: createHash('sha256').update(json).digest('base64url') }
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
      !Number.isSafeInteger(payload.d) || typeof payload.e !== 'string' ||
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
function requireUnifiedCapabilities(db: DatabaseSync): MsgvaultIndexCapabilities {
  const capabilities = indexCapabilities.get(db)
  if (!capabilities) {
    throw new ProductStoreError('unsupported_schema', 'msgvault unified-inbox index capabilities are unavailable')
  }
  return capabilities
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
  const subject = boundedTextField(row.subject, row.subject_overflow, 'subject', SUBJECT_BYTES)
  const snippet = boundedTextField(row.snippet, row.snippet_overflow, 'snippet', SNIPPET_BYTES)
  const senderName = boundedTextField(row.sender_name, row.sender_name_overflow, 'sender_name', SENDER_NAME_BYTES)
  const senderEmail = boundedEmailField(row.sender_email, row.sender_email_overflow, 'sender_email', SENDER_EMAIL_BYTES)
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

  if (strategy === 'source-fallback') {
    return `
      WITH ${eligibleSources},
      source_candidates AS MATERIALIZED (
        SELECT candidate.id AS message_id,
               candidate.conversation_id,
               candidate.source_id,
               source.identifier AS source_identifier,
               boring_mail_message_id(candidate.rfc822_message_id) AS valid_rfc822_message_id,
               substr(candidate.subject,1,${SUBJECT_PREFIX_CHARS}) AS subject,
               CASE WHEN candidate.subject IS NOT NULL AND length(candidate.subject)>${SUBJECT_PREFIX_CHARS} THEN 1 ELSE 0 END AS subject_overflow,
               substr(candidate.snippet,1,${SNIPPET_PREFIX_CHARS}) AS snippet,
               CASE WHEN candidate.snippet IS NOT NULL AND length(candidate.snippet)>${SNIPPET_PREFIX_CHARS} THEN 1 ELSE 0 END AS snippet_overflow,
               substr(sender.display_name,1,${SENDER_NAME_PREFIX_CHARS}) AS sender_name,
               CASE WHEN sender.display_name IS NOT NULL AND length(sender.display_name)>${SENDER_NAME_PREFIX_CHARS} THEN 1 ELSE 0 END AS sender_name_overflow,
               substr(sender.email_address,1,${SENDER_EMAIL_PREFIX_CHARS}) AS sender_email,
               CASE WHEN sender.email_address IS NOT NULL AND length(sender.email_address)>${SENDER_EMAIL_PREFIX_CHARS} THEN 1 ELSE 0 END AS sender_email_overflow,
               ${timestamp} AS message_at,
               candidate.is_read,
               candidate.attachment_count,
               CASE WHEN boring_mail_message_id(candidate.rfc822_message_id) IS NULL
                    THEN '#'||candidate.id ELSE candidate.rfc822_message_id END AS correlation_key,
               ${addressed('candidate', 'candidate_source')} AS addressed
          FROM eligible_sources candidate_source
          JOIN messages candidate INDEXED BY ${sourceIndex}
            ON candidate.source_id=candidate_source.source_id
          JOIN conversations conversation
            ON conversation.id=candidate.conversation_id
           AND conversation.source_id=candidate.source_id
          JOIN sources source ON source.id=candidate.source_id
          LEFT JOIN participants sender ON sender.id=candidate.sender_id
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
      )
      SELECT message_id,conversation_id,source_id,source_identifier,
             valid_rfc822_message_id,subject,subject_overflow,snippet,snippet_overflow,
             sender_name,sender_name_overflow,sender_email,sender_email_overflow,
             message_at,is_read,attachment_count,copy_count
        FROM ranked_candidates ranked
       WHERE representative_rank=1
         ${representativeKeyset}
       ORDER BY message_at DESC NULLS LAST,message_id DESC
       LIMIT ?
    `
  }

  return `
    WITH ${eligibleSources},
    recent_rows AS MATERIALIZED (
      SELECT candidate.*
        FROM messages candidate INDEXED BY ${liveIndex}
       WHERE ${liveMessage('candidate')}
         ${candidateKeyset}
       ORDER BY ${timestamp} DESC NULLS LAST,candidate.id DESC
       LIMIT ?
    ),
    recent_candidates AS MATERIALIZED (
      SELECT candidate.*,
             boring_mail_message_id(candidate.rfc822_message_id) AS valid_rfc822_message_id,
             CASE WHEN boring_mail_message_id(candidate.rfc822_message_id) IS NULL
                  THEN '#'||candidate.id ELSE candidate.rfc822_message_id END AS correlation_key
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
    )
    SELECT candidate.id AS message_id,
           candidate.conversation_id,
           candidate.source_id,
           source.identifier AS source_identifier,
           candidate.valid_rfc822_message_id,
           substr(candidate.subject,1,${SUBJECT_PREFIX_CHARS}) AS subject,
           CASE WHEN candidate.subject IS NOT NULL AND length(candidate.subject)>${SUBJECT_PREFIX_CHARS} THEN 1 ELSE 0 END AS subject_overflow,
           substr(candidate.snippet,1,${SNIPPET_PREFIX_CHARS}) AS snippet,
           CASE WHEN candidate.snippet IS NOT NULL AND length(candidate.snippet)>${SNIPPET_PREFIX_CHARS} THEN 1 ELSE 0 END AS snippet_overflow,
           substr(sender.display_name,1,${SENDER_NAME_PREFIX_CHARS}) AS sender_name,
           CASE WHEN sender.display_name IS NOT NULL AND length(sender.display_name)>${SENDER_NAME_PREFIX_CHARS} THEN 1 ELSE 0 END AS sender_name_overflow,
           substr(sender.email_address,1,${SENDER_EMAIL_PREFIX_CHARS}) AS sender_email,
           CASE WHEN sender.email_address IS NOT NULL AND length(sender.email_address)>${SENDER_EMAIL_PREFIX_CHARS} THEN 1 ELSE 0 END AS sender_email_overflow,
           COALESCE(candidate.sent_at,candidate.received_at,candidate.internal_date) AS message_at,
           candidate.is_read,
           candidate.attachment_count,
           selected.copy_count
      FROM selected_correlations selected
      JOIN recent_candidates candidate ON candidate.id=selected.message_id
      JOIN sources source ON source.id=candidate.source_id
      LEFT JOIN participants sender ON sender.id=candidate.sender_id
     ORDER BY COALESCE(candidate.sent_at,candidate.received_at,candidate.internal_date) DESC NULLS LAST,
              candidate.id DESC
     LIMIT ?
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
  const eligible = sourceInput(eligibleSources)
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
  const eligible = sourceInput(eligibleSources)
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
