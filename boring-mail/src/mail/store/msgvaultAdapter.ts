// bm-zf6 — MsgvaultProvider read side.
//
// Opens the msgvault SQLite archive READ-ONLY and projects it into boring-mail
// domain types (src/shared/types.ts). Product state never lives here; joins to
// product data happen by rfc822_message_id (+ source_id) at the product layer.
//
// msgvault is alpha software: this adapter is the ONLY module allowed to know
// its schema. Shape-checked on open and tested against 0.19; schema drift fails
// loudly here. msgvault exposes no runtime release-version metadata to pin.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'
import {
  ProductStoreError,
  type UnifiedInboxItem,
  type UnifiedInboxOptions,
  type UnifiedInboxPage,
} from './product/types.js'

/** msgvault release line this adapter was written against (spike: v0.19.3). */
export const MSGVAULT_TESTED_MAJOR_MINOR = '0.19'

export interface MsgvaultStoreOptions {
  /** Fail open if the archive shape differs from the tested contract. Default true. */
  strictSchema?: boolean
}

export interface ThreadSummary {
  id: number
  subject: string
  snippet: string
  messageCount: number
  unreadCount: number
  lastMessageAt: string | null
}

export interface MessageSummary {
  id: number
  conversationId: number
  rfc822MessageId: string | null
  subject: string | null
  snippet: string | null
  sentAt: string | null
  sender: { name?: string; email?: string } | null
  labels: string[]
  unread: boolean
  hasAttachments: boolean
}

export interface MessageBody {
  raw: Buffer
  format: string
}

/** @internal Product-owned source eligibility supplied to the adapter worker. */
export interface EligibleInboxSource {
  sourceId: number
  identities: string[]
}

/** @internal Per-storage-process cursor authority; never crosses RPC. */
export interface UnifiedInboxCursorAuthority {
  scope: string
  secret: Buffer
}

interface MsgvaultIndexCapabilities {
  rfc822: string
  liveRecency: string
  recipientsByMessage: string
}
const indexCapabilities = new WeakMap<DatabaseSync, MsgvaultIndexCapabilities>()

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
function indexColumns(db: DatabaseSync, name: string): Array<{ name: string | null }> {
  return db.prepare(`PRAGMA index_info(${quotedIdentifier(name)})`).all() as Array<{ name: string | null }>
}
function inspectIndexCapabilities(db: DatabaseSync): {
  value: MsgvaultIndexCapabilities | null
  errors: string[]
} {
  type IndexRow = { name: string; unique: number; partial: number }
  const messageIndexes = db.prepare(`PRAGMA index_list(messages)`).all() as IndexRow[]
  const recipientIndexes = db.prepare(`PRAGMA index_list(message_recipients)`).all() as IndexRow[]
  const rfc822 = messageIndexes.find((index) => index.unique === 0 && index.partial === 0 &&
    indexColumns(db, index.name)[0]?.name === 'rfc822_message_id')
  const recipientsByMessage = recipientIndexes.find((index) => index.partial === 0 &&
    indexColumns(db, index.name)[0]?.name === 'message_id')
  const indexSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
  const liveRecency = messageIndexes.find((index) => {
    if (index.partial !== 1) return false
    const columns = indexColumns(db, index.name)
    if (columns[0]?.name !== null || columns[1]?.name !== 'id') return false
    const sql = (indexSql.get(index.name) as { sql: string | null } | undefined)?.sql
      ?.toLowerCase().replace(/["`\[\]]/g, '').replace(/\s+/g, '') ?? ''
    return sql.includes('coalesce(sent_at,received_at,internal_date)desc,iddesc') &&
      sql.includes('wheredeleted_atisnullanddeleted_from_source_atisnull')
  })
  const errors = [
    !rfc822 ? 'messages requires a non-unique, non-partial index led by rfc822_message_id' : '',
    !liveRecency
      ? 'messages requires a live recency index on COALESCE(sent_at,received_at,internal_date) DESC,id DESC'
      : '',
    !recipientsByMessage
      ? 'message_recipients requires a non-partial index led by message_id'
      : '',
  ].filter(Boolean)
  return {
    value: rfc822 && liveRecency && recipientsByMessage
      ? { rfc822: rfc822.name, liveRecency: liveRecency.name, recipientsByMessage: recipientsByMessage.name }
      : null,
    errors,
  }
}

/** Conservative correlation/reply contract for provider Message-ID values. */
export function correlatableMessageId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 5 || value.length > 998 ||
      value[0] !== '<' || value.at(-1) !== '>') return null
  const inner = value.slice(1, -1)
  if (!inner || /[<>\x00-\x20\x7f-\xff]/.test(inner)) return null
  const at = inner.indexOf('@')
  if (at <= 0 || at !== inner.lastIndexOf('@') || at === inner.length - 1) return null
  return value
}

const REQUIRED_SCHEMA: Record<string, readonly string[]> = {
  sources: ['id', 'identifier'],
  messages: [
    'id',
    'conversation_id',
    'source_id',
    'rfc822_message_id',
    'message_type',
    'subject',
    'snippet',
    'sent_at',
    'received_at',
    'internal_date',
    'is_read',
    'attachment_count',
    'sender_id',
    'deleted_at',
    'deleted_from_source_at',
  ],
  conversations: [
    'id',
    'source_id',
    'conversation_type',
    'title',
    'message_count',
    'unread_count',
    'last_message_at',
    'last_message_preview',
  ],
  participants: ['id', 'email_address', 'display_name'],
  message_recipients: ['message_id', 'recipient_type', 'email_address'],
  message_labels: ['message_id', 'label_id'],
  labels: ['id', 'name'],
  message_raw: ['message_id', 'raw_data', 'raw_format', 'compression'],
  attachments: ['id', 'message_id', 'filename', 'mime_type', 'size', 'content_hash', 'storage_path'],
  messages_fts: ['message_id'],
}

/**
 * Open the archive read-only. Throws with a named remediation when the file is
 * missing or the schema has drifted from what this adapter speaks.
 *
 * NOTE: returns the raw handle deliberately — the product layer performs its own
 * rfc822/source-id joins (spike report §3). All product SQL lives in modules that
 * re-run the drift guard via this opener; do not persist handles elsewhere.
 */
export function openMsgvaultStore(dbPath: string, opts: MsgvaultStoreOptions = {}): { db: DatabaseSync } {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (e) {
    throw new Error(
      `REMEDIATION: cannot open msgvault archive at ${dbPath} (${(e as Error).message}). ` +
        `Run: msgvault init-db && msgvault add-account <email>, or point config at an existing archive.`,
    )
  }
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
    name: string
  }>
  const have = new Set(tables.map((t) => t.name))
  const missingTables = Object.keys(REQUIRED_SCHEMA).filter((table) => !have.has(table))
  const columnErrors: string[] = []
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    if (!have.has(table)) continue
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string; type: string; notnull: number; pk: number
    }>
    const names = new Set(columns.map((column) => column.name))
    const missing = required.filter((column) => !names.has(column))
    if (missing.length) columnErrors.push(`${table} missing column(s): ${missing.join(', ')}`)
    if (table === 'messages') {
      const id = columns.find((column) => column.name === 'id')
      const source = columns.find((column) => column.name === 'source_id')
      const rfc822 = columns.find((column) => column.name === 'rfc822_message_id')
      const messageType = columns.find((column) => column.name === 'message_type')
      const primaryKeys = columns.filter((column) => column.pk > 0)
      if (!id || !/int/i.test(id.type) || id.pk !== 1 || primaryKeys.length !== 1) {
        columnErrors.push('messages.id must have INTEGER affinity and be the single primary key')
      }
      if (!source || !/int/i.test(source.type) || source.notnull !== 1) {
        columnErrors.push('messages.source_id must be a NOT NULL integer')
      }
      if (!rfc822 || !/(char|clob|text)/i.test(rfc822.type)) {
        columnErrors.push('messages.rfc822_message_id must have TEXT affinity')
      }
      if (!messageType || !/(char|clob|text)/i.test(messageType.type) || messageType.notnull !== 1) {
        columnErrors.push('messages.message_type must be NOT NULL with TEXT affinity')
      }
    }
    if (table === 'sources') {
      const identifier = columns.find((column) => column.name === 'identifier')
      if (!identifier || !/(char|clob|text)/i.test(identifier.type) || identifier.notnull !== 1) {
        columnErrors.push('sources.identifier must be NOT NULL with TEXT affinity')
      }
    }
    if (table === 'conversations') {
      const source = columns.find((column) => column.name === 'source_id')
      if (!source || !/int/i.test(source.type) || source.notnull !== 1) {
        columnErrors.push('conversations.source_id must be a NOT NULL integer')
      }
    }
    if (table === 'message_recipients') {
      const message = columns.find((column) => column.name === 'message_id')
      const recipientType = columns.find((column) => column.name === 'recipient_type')
      const email = columns.find((column) => column.name === 'email_address')
      if (!message || !/int/i.test(message.type) || message.notnull !== 1) {
        columnErrors.push('message_recipients.message_id must be a NOT NULL integer')
      }
      if (!recipientType || !/(char|clob|text)/i.test(recipientType.type) || recipientType.notnull !== 1) {
        columnErrors.push('message_recipients.recipient_type must be NOT NULL with TEXT affinity')
      }
      if (!email || !/(char|clob|text)/i.test(email.type)) {
        columnErrors.push('message_recipients.email_address must have TEXT affinity')
      }
    }
  }
  const capabilities = inspectIndexCapabilities(db)
  const ftsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE name='messages_fts'`).get() as
    | { sql: string | null }
    | undefined
  const invalidFts =
    have.has('messages_fts') && !/CREATE\s+VIRTUAL\s+TABLE[\s\S]*USING\s+fts5/i.test(ftsRow?.sql ?? '')
  if (missingTables.length > 0 || columnErrors.length > 0 || invalidFts || capabilities.errors.length > 0) {
    const details = [
      missingTables.length > 0 ? `missing table(s): ${missingTables.join(', ')}` : '',
      ...columnErrors,
      invalidFts ? 'messages_fts is not an FTS5 virtual table' : '',
      ...capabilities.errors,
    ]
      .filter(Boolean)
      .join('; ')
    const msg =
      `REMEDIATION: msgvault schema drift — ${details}. ` +
      `This adapter targets ${MSGVAULT_TESTED_MAJOR_MINOR}.x; upgrade boring-mail or pin msgvault.`
    if (opts.strictSchema !== false) {
      db.close()
      throw new Error(msg)
    }
    console.warn(`[boring-mail] ${msg}`)
  }
  if (capabilities.value) indexCapabilities.set(db, capabilities.value)
  db.function('boring_mail_message_id', { deterministic: true, directOnly: true }, correlatableMessageId)
  return { db }
}

function rowToMessageSummary(r: Record<string, unknown>): MessageSummary {
  return {
    id: r.id as number,
    conversationId: r.conversation_id as number,
    rfc822MessageId: (r.rfc822_message_id as string) ?? null,
    subject: (r.subject as string) ?? null,
    snippet: (r.snippet as string) ?? null,
    sentAt: (r.sent_at as string) ?? null,
    sender:
      r.sender_email == null && r.sender_name == null
        ? null
        : {
            email: (r.sender_email as string) ?? undefined,
            name: (r.sender_name as string) ?? undefined,
          },
    labels: r.labels ? String(r.labels).split('\u001f') : [],
    unread: Number(r.is_read) === 0,
    hasAttachments: Number(r.attachment_count) > 0,
  }
}

const MESSAGE_SUMMARY_SELECT = `
  SELECT m.id, m.conversation_id, m.rfc822_message_id, m.subject, m.snippet,
         m.sent_at, m.is_read, m.attachment_count,
         p.email_address AS sender_email, p.display_name AS sender_name,
         (SELECT GROUP_CONCAT(l.name, '\u001f') FROM message_labels ml
            JOIN labels l ON l.id = ml.label_id
           WHERE ml.message_id = m.id) AS labels
    FROM messages m
    LEFT JOIN participants p ON p.id = m.sender_id`

export function listThreads(
  db: DatabaseSync,
  opts: { limit?: number; offset?: number; label?: string; unreadOnly?: boolean } = {},
): ThreadSummary[] {
  const limit = Math.min(opts.limit ?? 50, 500)
  const clauses: string[] = [
    `c.conversation_type = 'email_thread'`,
    // msgvault derives thread deletion from live messages (no c.deleted_at in
    // the real schema) — guard on live messages only.
    `EXISTS (SELECT 1 FROM messages m3 WHERE m3.conversation_id = c.id
      AND m3.deleted_at IS NULL AND m3.deleted_from_source_at IS NULL)`,
  ]
  const params: Array<string | number> = []
  if (opts.unreadOnly) clauses.push('c.unread_count > 0')
  if (opts.label) {
    clauses.push(
      `EXISTS (SELECT 1 FROM messages m2 JOIN message_labels ml2 ON ml2.message_id = m2.id
        JOIN labels l2 ON l2.id = ml2.label_id WHERE m2.conversation_id = c.id
          AND m2.deleted_at IS NULL AND m2.deleted_from_source_at IS NULL AND l2.name = ?)`,
    )
    params.push(opts.label)
  }
  const sql = `
    SELECT c.id, COALESCE(c.title, m.subject, '(no subject)') AS subject,
           COALESCE(c.last_message_preview, '') AS snippet,
           c.message_count, c.unread_count, c.last_message_at
      FROM conversations c
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages WHERE conversation_id = c.id
          AND deleted_at IS NULL AND deleted_from_source_at IS NULL
        ORDER BY sent_at DESC LIMIT 1)
     WHERE ${clauses.join(' AND ')}
     ORDER BY c.last_message_at DESC NULLS LAST
     LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...params, limit, opts.offset ?? 0) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    subject: (r.subject as string) ?? '(no subject)',
    snippet: (r.snippet as string) ?? '',
    messageCount: Number(r.message_count ?? 0),
    unreadCount: Number(r.unread_count ?? 0),
    lastMessageAt: (r.last_message_at as string) ?? null,
  }))
}

const UNIFIED_INBOX_MAX_LIMIT = 200
const MAX_CURSOR_LENGTH = 2_048

interface UnifiedCursorPayload {
  v: 1
  s: string
  d: number
  e: string
  t: string | null
  i: number
}

function boundedLimit(value: number | undefined): number {
  const selected = value ?? 50
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
function signCursor(payload: UnifiedCursorPayload, authority: UnifiedInboxCursorAuthority): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', authority.secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}
function readCursor(
  cursor: string,
  authority: UnifiedInboxCursorAuthority,
  expectedDataVersion: number,
  expectedSourceDigest: string,
): UnifiedCursorPayload {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed')
  }
  const parts = cursor.split('.')
  if (parts.length !== 2) throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed')
  const expectedSignature = createHmac('sha256', authority.secret).update(parts[0]!).digest()
  let suppliedSignature: Buffer
  try { suppliedSignature = Buffer.from(parts[1]!, 'base64url') }
  catch { throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed') }
  if (suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor signature is invalid')
  }
  let value: unknown
  try { value = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) }
  catch { throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor is malformed')
  }
  const payload = value as Record<string, unknown>
  if (payload.v !== 1 || typeof payload.s !== 'string' ||
      !Number.isSafeInteger(payload.d) || typeof payload.e !== 'string' ||
      (payload.t !== null && typeof payload.t !== 'string') ||
      !Number.isSafeInteger(payload.i) || Number(payload.i) <= 0) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor has an invalid payload')
  }
  if (payload.s !== authority.scope || payload.d !== expectedDataVersion ||
      payload.e !== expectedSourceDigest) {
    throw new ProductStoreError('stale_cursor', 'unified inbox cursor expired after storage state changed')
  }
  return payload as unknown as UnifiedCursorPayload
}
function liveEmail(alias: string): string {
  return `${alias}.message_type='email' AND ${alias}.deleted_at IS NULL AND ${alias}.deleted_from_source_at IS NULL`
}
function requireUnifiedCapabilities(db: DatabaseSync): MsgvaultIndexCapabilities {
  const capabilities = indexCapabilities.get(db)
  if (!capabilities) {
    throw new ProductStoreError('unsupported_schema', 'msgvault unified-inbox index capabilities are unavailable')
  }
  return capabilities
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
  return {
    messageId: positiveInteger(row.message_id, 'message_id'),
    conversationId: positiveInteger(row.conversation_id, 'conversation_id'),
    sourceId: positiveInteger(row.source_id, 'source_id'),
    sourceIdentifier: row.source_identifier,
    rfc822MessageId: rfc822,
    subject: nullableText(row.subject, 'subject'),
    snippet: nullableText(row.snippet, 'snippet'),
    messageAt: nullableText(row.message_at, 'message_at'),
    unread: !booleanInteger(row.is_read, 'is_read'),
    hasAttachments: Number(attachmentCount) > 0,
    coalesced: copyCount > 1,
    copyCount,
  }
}

/**
 * Project connected product accounts into one deterministic inbox page. The
 * outer scan is forced through msgvault's live-recency index and stops after
 * one page; duplicate winner/count probes use the global Message-ID index.
 */
type UnifiedKeysetMode = 'all' | 'before-timestamp' | 'all-null' | 'before-null'
function unifiedInboxSql(capabilities: MsgvaultIndexCapabilities, mode: UnifiedKeysetMode = 'all'): string {
  const liveIndex = quotedIdentifier(capabilities.liveRecency)
  const rfc822Index = quotedIdentifier(capabilities.rfc822)
  const recipientIndex = quotedIdentifier(capabilities.recipientsByMessage)
  const addressed = (message: string, source: string): string => `EXISTS (
    SELECT 1 FROM message_recipients recipient INDEXED BY ${recipientIndex}
    JOIN json_each(${source}.identities_json) identity
      ON lower(trim(recipient.email_address))=identity.value
    WHERE recipient.message_id=${message}.id
      AND lower(recipient.recipient_type) IN ('to','cc')
  )`
  const timestamp = 'COALESCE(candidate.sent_at,candidate.received_at,candidate.internal_date)'
  const keyset = mode === 'before-timestamp'
    ? `AND ${timestamp} IS NOT NULL
       AND ${timestamp}<=?
       AND (${timestamp}<? OR candidate.id<?)`
    : mode === 'all-null'
      ? `AND ${timestamp} IS NULL`
      : mode === 'before-null'
        ? `AND ${timestamp} IS NULL AND candidate.id<?`
        : ''
  return `
    WITH eligible_sources AS NOT MATERIALIZED (
      SELECT CAST(json_extract(value,'$.sourceId') AS INTEGER) AS source_id,
             json_extract(value,'$.identities') AS identities_json
        FROM json_each(?)
    )
    SELECT candidate.id AS message_id,
           candidate.conversation_id,
           candidate.source_id,
           source.identifier AS source_identifier,
           boring_mail_message_id(candidate.rfc822_message_id) AS valid_rfc822_message_id,
           candidate.subject,
           candidate.snippet,
           COALESCE(candidate.sent_at,candidate.received_at,candidate.internal_date) AS message_at,
           candidate.is_read,
           candidate.attachment_count,
           CASE WHEN boring_mail_message_id(candidate.rfc822_message_id) IS NULL THEN 1 ELSE (
             SELECT count(*)
               FROM messages copy INDEXED BY ${rfc822Index}
               JOIN eligible_sources copy_source ON copy_source.source_id=copy.source_id
               JOIN conversations copy_conversation
                 ON copy_conversation.id=copy.conversation_id
                AND copy_conversation.source_id=copy.source_id
              WHERE copy.rfc822_message_id=candidate.rfc822_message_id
                AND ${liveEmail('copy')}
           ) END AS copy_count
      FROM messages candidate INDEXED BY ${liveIndex}
      JOIN eligible_sources candidate_source ON candidate_source.source_id=candidate.source_id
      JOIN sources source ON source.id=candidate.source_id
      JOIN conversations conversation
        ON conversation.id=candidate.conversation_id
       AND conversation.source_id=candidate.source_id
     WHERE ${liveEmail('candidate')}
       ${keyset}
       AND (
         boring_mail_message_id(candidate.rfc822_message_id) IS NULL OR
         candidate.id=(
           SELECT primary_copy.id
             FROM messages primary_copy INDEXED BY ${rfc822Index}
             JOIN eligible_sources primary_source ON primary_source.source_id=primary_copy.source_id
             JOIN conversations primary_conversation
               ON primary_conversation.id=primary_copy.conversation_id
              AND primary_conversation.source_id=primary_copy.source_id
            WHERE primary_copy.rfc822_message_id=candidate.rfc822_message_id
              AND ${liveEmail('primary_copy')}
            ORDER BY ${addressed('primary_copy', 'primary_source')} DESC,
                     COALESCE(primary_copy.sent_at,primary_copy.received_at,primary_copy.internal_date) DESC NULLS LAST,
                     primary_copy.source_id ASC,
                     primary_copy.id ASC
            LIMIT 1
         )
       )
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
): string[] {
  const capabilities = requireUnifiedCapabilities(db)
  const eligible = sourceInput(eligibleSources)
  const mode: UnifiedKeysetMode = !after ? 'all' : after.messageAt === null ? 'before-null' : 'before-timestamp'
  const args = !after ? [] : after.messageAt === null
    ? [after.messageId]
    : [after.messageAt, after.messageAt, after.messageId]
  return (db.prepare(`EXPLAIN QUERY PLAN ${unifiedInboxSql(capabilities, mode)}`).all(
    eligible.json, ...args, 51,
  ) as Array<{ detail: unknown }>).map((row) => {
    if (typeof row.detail !== 'string') {
      throw new ProductStoreError('corrupt_data', 'msgvault query plan detail must be text')
    }
    return row.detail
  })
}

export function listUnifiedInbox(
  db: DatabaseSync,
  eligibleSources: EligibleInboxSource[],
  authority: UnifiedInboxCursorAuthority,
  opts: UnifiedInboxOptions = {},
): UnifiedInboxPage {
  if (!authority || typeof authority.scope !== 'string' || !authority.scope ||
      !Buffer.isBuffer(authority.secret) || authority.secret.length < 32) {
    throw new ProductStoreError('invalid_input', 'unified inbox cursor authority is required')
  }
  const limit = boundedLimit(opts.limit)
  const capabilities = requireUnifiedCapabilities(db)
  const eligible = sourceInput(eligibleSources)
  const version = dataVersion(db)
  const cursor = opts.cursor
    ? readCursor(opts.cursor, authority, version, eligible.digest)
    : null
  if (eligibleSources.length === 0) return { items: [], nextCursor: null }

  const run = (mode: UnifiedKeysetMode, args: Array<string | number | null>, wanted: number) =>
    db.prepare(unifiedInboxSql(capabilities, mode)).all(
      eligible.json, ...args, wanted,
    ) as Array<Record<string, unknown>>
  let rows: Array<Record<string, unknown>>
  if (!cursor) {
    rows = run('all', [], limit + 1)
  } else if (cursor.t === null) {
    rows = run('before-null', [cursor.i], limit + 1)
  } else {
    rows = run('before-timestamp', [cursor.t, cursor.t, cursor.i], limit + 1)
    if (rows.length < limit + 1) {
      rows.push(...run('all-null', [], limit + 1 - rows.length))
    }
  }
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(decodeUnifiedInboxItem)
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last
      ? signCursor({
          v: 1,
          s: authority.scope,
          d: version,
          e: eligible.digest,
          t: last.messageAt,
          i: last.messageId,
        }, authority)
      : null,
  }
}

export function getThreadMessages(db: DatabaseSync, conversationId: number): MessageSummary[] {
  const rows = db
    .prepare(
      `${MESSAGE_SUMMARY_SELECT}
        WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND m.deleted_from_source_at IS NULL
        ORDER BY m.sent_at ASC`,
    )
    .all(conversationId) as Array<Record<string, unknown>>
  return rows.map(rowToMessageSummary)
}

export interface ResolvedMsgvaultReply {
  rfc822MessageId: string
  sourceId: number
}
/** Resolve the immutable msgvault row key to server-owned reply identity. */
export function resolveReplyTarget(db: DatabaseSync, messageId: number): ResolvedMsgvaultReply | null {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('msgvault message id must be a positive safe integer')
  const row = db
    .prepare(`SELECT rfc822_message_id,source_id FROM messages
      WHERE id=? AND deleted_at IS NULL AND deleted_from_source_at IS NULL`)
    .get(messageId) as Record<string, unknown> | undefined
  if (!row) return null
  const rfc822MessageId = correlatableMessageId(row.rfc822_message_id)
  if (rfc822MessageId === null) return null
  if (!Number.isSafeInteger(row.source_id) || Number(row.source_id) <= 0) {
    throw new ProductStoreError('corrupt_data', 'msgvault reply identity row has an invalid source id')
  }
  return { rfc822MessageId, sourceId: row.source_id as number }
}

/** Trusted ownership check retained for read-side callers. */
export function hasMessageAtSource(db: DatabaseSync, rfc822MessageId: string, sourceId: number): boolean {
  const correlated = correlatableMessageId(rfc822MessageId)
  if (correlated === null || !Number.isSafeInteger(sourceId) || sourceId <= 0) return false
  return (
    db
      .prepare(
        `
    SELECT 1 FROM messages
    WHERE rfc822_message_id=? AND source_id=?
      AND deleted_at IS NULL AND deleted_from_source_at IS NULL LIMIT 1
  `,
      )
      .get(correlated, sourceId) != null
  )
}

export function getMessage(db: DatabaseSync, messageId: number): MessageSummary | null {
  const rows = db
    .prepare(`${MESSAGE_SUMMARY_SELECT}
      WHERE m.id = ? AND m.deleted_at IS NULL AND m.deleted_from_source_at IS NULL`)
    .all(messageId) as Array<Record<string, unknown>>
  return rows.length > 0 ? rowToMessageSummary(rows[0]) : null
}

/**
 * FTS5 search with Gmail-ish user queries; returns matching messages, newest first.
 * User input is wrapped as a quoted PHRASE: FTS5 syntax characters in raw input
 * (`subject:x`, `-foo`, `a OR b`, unbalanced quotes/parens) must never be parsed
 * as query syntax, and malformed MATCH must degrade to empty results, not throw.
 */
export function searchMessages(
  db: DatabaseSync,
  query: string,
  opts: { limit?: number } = {},
): MessageSummary[] {
  const safe = `"${query.replace(/"/g, '""')}"`
  const rows = db.prepare(
    `${MESSAGE_SUMMARY_SELECT}
        JOIN messages_fts f ON f.message_id = m.id
       WHERE messages_fts MATCH ?
         AND m.deleted_at IS NULL
         AND m.deleted_from_source_at IS NULL
       ORDER BY m.sent_at DESC
       LIMIT ?`,
  )
  let matched: Array<Record<string, unknown>>
  try {
    matched = rows.all(safe, Math.min(opts.limit ?? 25, 200)) as Array<Record<string, unknown>>
  } catch {
    return [] // malformed MATCH (e.g. only syntax chars) degrades to no results
  }
  return matched.map(rowToMessageSummary)
}

/** Raw MIME for a message (zlib-compressed in message_raw). */
export function readRawMessage(db: DatabaseSync, messageId: number): MessageBody | null {
  const row = db
    .prepare(`SELECT raw_data, raw_format, compression FROM message_raw WHERE message_id = ?`)
    .get(messageId) as { raw_data: Buffer; raw_format: string; compression: string } | undefined
  if (!row) return null
  const buf = Buffer.from(row.raw_data)
  const raw = row.compression === 'zlib' ? inflateSync(buf) : buf
  return { raw, format: row.raw_format }
}

export interface AttachmentRef {
  id: number
  filename: string | null
  mimeType: string | null
  size: number
  contentHash: string
  storagePath: string
}

export function listAttachments(db: DatabaseSync, messageId: number): AttachmentRef[] {
  const rows = db
    .prepare(
      `SELECT id, filename, mime_type, size, content_hash, storage_path
         FROM attachments WHERE message_id = ?`,
    )
    .all(messageId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    filename: (r.filename as string) ?? null,
    mimeType: (r.mime_type as string) ?? null,
    size: Number(r.size ?? 0),
    contentHash: String(r.content_hash ?? ''),
    storagePath: String(r.storage_path ?? ''),
  }))
}

/** Absolute path of a content-addressed attachment inside the archive root. */
export function attachmentAbsolutePath(archiveRoot: string, ref: AttachmentRef): string {
  return join(archiveRoot, ref.storagePath)
}
