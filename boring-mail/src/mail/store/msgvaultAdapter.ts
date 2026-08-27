// bm-zf6 — MsgvaultProvider read side.
//
// Opens the msgvault SQLite archive READ-ONLY and projects it into boring-mail
// domain types (src/shared/types.ts). Product state never lives here; joins to
// product data happen by rfc822_message_id (+ source_id) at the product layer.
//
// msgvault is alpha software: this adapter and its focused internal projection
// module are the ONLY modules allowed to know its schema. Shape-checked on open
// and tested against 0.19; schema drift fails loudly here. msgvault exposes no
// runtime release-version metadata to pin.
import { DatabaseSync } from 'node:sqlite'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'
import { ProductStoreError } from './product/types.js'

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

export {
  correlatableMessageId,
  explainUnifiedInboxQueryPlan,
  listUnifiedInbox,
} from './msgvault/unifiedInboxProjection.js'
export type {
  EligibleInboxSource,
  UnifiedInboxCursorAuthority,
} from './msgvault/unifiedInboxProjection.js'
import {
  correlatableMessageId,
  inspectIndexCapabilities,
  rememberIndexCapabilities,
} from './msgvault/unifiedInboxProjection.js'

type SchemaColumn = { name: string; type: string; notnull: number; pk: number }
function validateIntegerPrimaryKey(columns: SchemaColumn[], table: string, errors: string[]): void {
  const id = columns.find((column) => column.name === 'id')
  const primaryKeys = columns.filter((column) => column.pk > 0)
  if (!id || !/int/i.test(id.type) || id.pk !== 1 || primaryKeys.length !== 1) {
    errors.push(`${table}.id must have INTEGER affinity and be the single primary key`)
  }
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
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as SchemaColumn[]
    const names = new Set(columns.map((column) => column.name))
    const missing = required.filter((column) => !names.has(column))
    if (missing.length) columnErrors.push(`${table} missing column(s): ${missing.join(', ')}`)
    if (table === 'messages' || table === 'sources' || table === 'conversations') {
      validateIntegerPrimaryKey(columns, table, columnErrors)
    }
    if (table === 'messages') {
      const source = columns.find((column) => column.name === 'source_id')
      const rfc822 = columns.find((column) => column.name === 'rfc822_message_id')
      const messageType = columns.find((column) => column.name === 'message_type')
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
      throw new ProductStoreError('unsupported_schema', msg)
    }
    console.warn(`[boring-mail] ${msg}`)
  }
  if (capabilities.value) rememberIndexCapabilities(db, capabilities.value)
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
    .prepare(`SELECT m.rfc822_message_id,m.source_id FROM messages m
      JOIN conversations c ON c.id=m.conversation_id AND c.source_id=m.source_id
      WHERE m.id=? AND m.message_type='email' AND c.conversation_type='email_thread'
        AND m.deleted_at IS NULL AND m.deleted_from_source_at IS NULL`)
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
