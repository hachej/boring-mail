// bm-zf6 — MsgvaultProvider read side.
//
// Opens the msgvault SQLite archive READ-ONLY and projects it into boring-mail
// domain types (src/shared/types.ts). Product state never lives here; joins to
// product data happen by rfc822_message_id (+ source_id) at the product layer.
//
// msgvault is alpha software: this adapter is the ONLY module allowed to know
// its schema. Pin-checked on open; schema drift fails loudly here, nowhere else.
import { DatabaseSync } from 'node:sqlite'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'

/** msgvault release line this adapter was written against (spike: v0.19.3). */
export const MSGVAULT_TESTED_MAJOR_MINOR = '0.19'

export interface MsgvaultStoreOptions {
  /** Fail open if the archive's schema version is not the tested one. Default true. */
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

const REQUIRED_TABLES = [
  'messages',
  'conversations',
  'participants',
  'message_labels',
  'labels',
  'message_raw',
  'attachments',
  'messages_fts',
] as const

/**
 * Open the archive read-only. Throws with a named remediation when the file is
 * missing or the schema has drifted from what this adapter speaks.
 *
 * NOTE: returns the raw handle deliberately — the product layer performs its own
 * rfc822/source-id joins (spike report §3). All product SQL lives in modules that
 * re-run the drift guard via this opener; do not persist handles elsewhere.
 */
export function openMsgvaultStore(
  dbPath: string,
  opts: MsgvaultStoreOptions = {},
): { db: DatabaseSync } {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (e) {
    throw new Error(
      `REMEDIATION: cannot open msgvault archive at ${dbPath} (${(e as Error).message}). ` +
        `Run: msgvault init-db && msgvault add-account <email>, or point config at an existing archive.`,
    )
  }
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
  const have = new Set(tables.map((t) => t.name))
  const missing = REQUIRED_TABLES.filter((t) => !have.has(t))
  if (missing.length > 0) {
    db.close()
    const msg =
      `REMEDIATION: msgvault schema drift — missing table(s): ${missing.join(', ')}. ` +
      `This adapter targets ${MSGVAULT_TESTED_MAJOR_MINOR}.x; upgrade boring-mail or pin msgvault.`
    if (opts.strictSchema !== false) throw new Error(msg)
    console.warn(`[boring-mail] ${msg}`)
  }
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
    `EXISTS (SELECT 1 FROM messages m3 WHERE m3.conversation_id = c.id AND m3.deleted_at IS NULL)`,
  ]
  const params: Array<string | number> = []
  if (opts.unreadOnly) clauses.push('c.unread_count > 0')
  if (opts.label) {
    clauses.push(
      `EXISTS (SELECT 1 FROM messages m2 JOIN message_labels ml2 ON ml2.message_id = m2.id
        JOIN labels l2 ON l2.id = ml2.label_id WHERE m2.conversation_id = c.id AND l2.name = ?)`,
    )
    params.push(opts.label)
  }
  const sql = `
    SELECT c.id, COALESCE(c.title, m.subject, '(no subject)') AS subject,
           COALESCE(c.last_message_preview, '') AS snippet,
           c.message_count, c.unread_count, c.last_message_at
      FROM conversations c
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL
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
        WHERE m.conversation_id = ? AND m.deleted_at IS NULL
        ORDER BY m.sent_at ASC`,
    )
    .all(conversationId) as Array<Record<string, unknown>>
  return rows.map(rowToMessageSummary)
}

/** Trusted ownership check used by productDb for reply-account binding. */
export function hasMessageAtSource(
  db: DatabaseSync,
  rfc822MessageId: string,
  sourceId: number,
): boolean {
  return db.prepare(`
    SELECT 1 FROM messages
    WHERE rfc822_message_id=? AND source_id=? AND deleted_at IS NULL LIMIT 1
  `).get(rfc822MessageId, sourceId) != null
}

export function getMessage(db: DatabaseSync, messageId: number): MessageSummary | null {
  const rows = db
    .prepare(`${MESSAGE_SUMMARY_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL`)
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
  const rows = db
    .prepare(
      `${MESSAGE_SUMMARY_SELECT}
        JOIN messages_fts f ON f.message_id = m.id
       WHERE messages_fts MATCH ?
         AND m.deleted_at IS NULL
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
