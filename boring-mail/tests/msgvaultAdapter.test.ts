// bm-zf6 — adapter tests run against a SYNTHETIC msgvault fixture (schema-faithful
// subset, zlib raw MIME). No personal data is ever committed.
// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  attachmentAbsolutePath,
  getThreadMessages,
  hasMessageAtSource,
  listAttachments,
  listThreads,
  openMsgvaultStore,
  readRawMessage,
  searchMessages,
} from '../src/mail/store/msgvaultAdapter.js'

const SCHEMA = `
CREATE TABLE sources (id INTEGER PRIMARY KEY, kind TEXT, email TEXT);
CREATE TABLE participants (
  id INTEGER PRIMARY KEY,
  email_address TEXT,
  display_name TEXT,
  domain TEXT
);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_conversation_id TEXT,
  conversation_type TEXT NOT NULL,
  title TEXT,
  participant_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  last_message_at DATETIME,
  last_message_preview TEXT,
  UNIQUE(source_id, source_conversation_id)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_message_id TEXT,
  rfc822_message_id TEXT,
  message_type TEXT NOT NULL DEFAULT 'email',
  sent_at DATETIME,
  internal_date DATETIME,
  sender_id INTEGER REFERENCES participants(id),
  subject TEXT,
  snippet TEXT,
  is_read BOOLEAN DEFAULT TRUE,
  attachment_count INTEGER DEFAULT 0,
  deleted_at DATETIME
);
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  source_label_id TEXT,
  name TEXT NOT NULL,
  label_type TEXT,
  system_role TEXT
);
CREATE TABLE message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (message_id, label_id)
);
CREATE TABLE message_raw (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  raw_data BLOB NOT NULL,
  raw_format TEXT NOT NULL,
  compression TEXT DEFAULT 'zlib',
  encryption_version INTEGER DEFAULT 0
);
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_hash TEXT,
  storage_path TEXT NOT NULL
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED, subject, body, from_addr
);
`

function mimeMessage(opts: { from: string; to: string; subject: string; body: string; messageId: string }): Buffer {
  const raw = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId}`,
    `Date: Mon, 24 Aug 2026 10:00:00 +0000`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    opts.body,
  ].join('\r\n')
  return Buffer.from(raw)
}

describe('msgvaultAdapter', () => {
  let dbPath: string
  let db: DatabaseSync
  let store: { db: DatabaseSync }

  beforeAll(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'msgvault-fixture-')), 'fixture.db')
    db = new DatabaseSync(dbPath)
    db.exec(SCHEMA)

    db.exec(`INSERT INTO sources (id, kind, email) VALUES (1, 'gmail', 'fixture@example.com')`)
    db.exec(
      `INSERT INTO participants (id, email_address, display_name, domain) VALUES
       (1, 'alice@example.com', 'Alice', 'example.com'),
       (2, 'bob@example.com', 'Bob', 'example.com')`,
    )
    // thread 1: two messages, one unread
    db.exec(
      `INSERT INTO conversations (id, source_id, source_conversation_id, conversation_type,
        title, message_count, unread_count, last_message_at, last_message_preview)
       VALUES (1, 1, 'thr_1', 'email_thread', 'Quarterly report',
         2, 1, '2026-08-20 12:00:00', 'see attached numbers')`,
    )
    db.exec(
      `INSERT INTO messages (id, conversation_id, source_id, source_message_id, rfc822_message_id,
        sent_at, sender_id, subject, snippet, is_read)
       VALUES
        (1, 1, 1, 'gmsg_1', '<q1@example.com>', '2026-08-19 09:00:00', 2, 'Quarterly report', 'here are the numbers', 1),
        (2, 1, 1, 'gmsg_2', '<q2@example.com>', '2026-08-20 12:00:00', 1, 'Re: Quarterly report', 'see attached numbers', 0)`,
    )
    const raw = deflateSync(
      mimeMessage({
        from: 'Alice <alice@example.com>',
        to: 'bob@example.com',
        subject: 'Re: Quarterly report',
        body: 'See attached numbers for Q3.',
        messageId: '<q2@example.com>',
      }),
    )
    db.prepare(
      `INSERT INTO message_raw (message_id, raw_data, raw_format, compression) VALUES (?, ?, 'mime', 'zlib')`,
    ).run(2, raw)
    db.exec(`INSERT INTO labels (id, source_id, name, label_type) VALUES (1, 1, 'INBOX', 'system'), (2, 1, 'UNREAD', 'system')`)
    db.exec(`INSERT INTO message_labels VALUES (1, 1), (2, 1), (2, 2)`)
    db.prepare(
      `INSERT INTO messages_fts (message_id, subject, body, from_addr) VALUES (2, 'Re: Quarterly report', 'See attached numbers for Q3.', 'alice@example.com')`,
    ).run()
    db.exec(
      `INSERT INTO attachments (id, message_id, filename, mime_type, size, content_hash, storage_path)
       VALUES (1, 2, 'q3.xlsx', 'application/vnd.ms-excel', 1234,
         'ab/abcd1234', 'ab/abcd1234.blob')`,
    )
    db.prepare(`UPDATE messages SET attachment_count = 1 WHERE id = 2`).run()

    // soft-deleted message in thread 2 must never surface
    db.exec(
      `INSERT INTO conversations (id, source_id, source_conversation_id, conversation_type, title, message_count)
       VALUES (2, 1, 'thr_2', 'email_thread', 'Deleted thing', 1)`,
    )
    db.exec(
      `INSERT INTO messages (id, conversation_id, source_id, source_message_id, rfc822_message_id, subject, deleted_at)
       VALUES (3, 2, 1, 'gmsg_3', '<d@example.com>', 'Deleted thing', CURRENT_TIMESTAMP)`,
    )

    store = { db }
  })

  afterAll(() => {
    db.close() // store.db aliases the same connection
  })

  it('opens read-only and rejects schema drift', async () => {
    const opened = openMsgvaultStore(dbPath)
    expect(opened.db.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 3 })

    const notAnArchive = join(mkdtempSync(join(tmpdir(), 'msgvault-empty-')), 'empty.db')
    const empty = new DatabaseSync(notAnArchive)
    empty.exec('CREATE TABLE other(x)')
    empty.close()
    expect(() => openMsgvaultStore(notAnArchive)).toThrow(/schema drift/)
    expect(() => openMsgvaultStore(join(tmpdir(), 'does-not-exist.db'))).toThrow(/REMEDIATION/)
  })

  it('lists email threads newest-first with unread counts', async () => {
    const threads = listThreads(store.db)
    expect(threads).toHaveLength(1) // thread 2's only message is soft-deleted... but conversation row remains
    const t = threads[0]
    expect(t.subject).toBe('Quarterly report')
    expect(t.unreadCount).toBe(1)
    expect(t.messageCount).toBe(2)
    // unreadOnly filter keeps it; a fully-read archive would drop it
    expect(listThreads(store.db, { unreadOnly: true })).toHaveLength(1)
    expect(listThreads(store.db, { label: 'SENT' })).toHaveLength(0)
    expect(listThreads(store.db, { label: 'INBOX' })).toHaveLength(1)
  })

  it('verifies trusted reply ownership by exact rfc822+source pair', () => {
    expect(hasMessageAtSource(store.db, '<q2@example.com>', 1)).toBe(true)
    expect(hasMessageAtSource(store.db, '<q2@example.com>', 999)).toBe(false)
    expect(hasMessageAtSource(store.db, '<missing@example.com>', 1)).toBe(false)
    expect(hasMessageAtSource(store.db, '<d@example.com>', 1)).toBe(false) // soft-deleted
  })

  it('returns thread messages with sender, labels and unread flag', async () => {
    const msgs = getThreadMessages(store.db, 1)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].sender?.email).toBe('bob@example.com')
    expect(msgs[1].unread).toBe(true)
    expect(msgs[1].labels).toContain('UNREAD')
    expect(msgs.every((m) => m.rfc822MessageId)).toBe(true)
  })

  it('searches via FTS5 and never returns soft-deleted rows', async () => {
    const hits = searchMessages(store.db, 'quarterly')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(2)
    expect(searchMessages(store.db, 'Deleted')).toHaveLength(0)
  })

  it('inflates raw MIME', async () => {
    const body = readRawMessage(store.db, 2)!
    expect(body.format).toBe('mime')
    expect(body.raw.toString('utf8')).toContain('See attached numbers for Q3.')
    expect(readRawMessage(store.db, 1)).toBeNull()
  })

  it('resolves content-addressed attachments', async () => {
    const atts = listAttachments(store.db, 2)
    expect(atts).toHaveLength(1)
    expect(atts[0].contentHash).toBe('ab/abcd1234')
    expect(attachmentAbsolutePath('/archive/root', atts[0])).toBe('/archive/root/ab/abcd1234.blob')
  })
})

describe('msgvaultAdapter — review-finding edges', () => {
  let dbPath: string
  let store: { db: DatabaseSync }
  let raw: DatabaseSync

  beforeAll(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'msgvault-edge-')), 'fixture.db')
    raw = new DatabaseSync(dbPath)
    raw.exec(SCHEMA)
    raw.exec(`INSERT INTO sources (id, kind, email) VALUES (1, 'gmail', 'edge@example.com')`)
    raw.exec(`INSERT INTO participants (id, email_address, display_name) VALUES (1, 'x@example.com', 'X')`)
    raw.exec(
      `INSERT INTO conversations (id, source_id, source_conversation_id, conversation_type, title)
       VALUES (1, 1, 't1', 'email_thread', 'Edge')`,
    )
    raw.exec(
      `INSERT INTO messages (id, conversation_id, source_id, rfc822_message_id, subject, snippet, deleted_at)
       VALUES (10, 1, 1, '<e1@example.com>', 'Deleted edge', 'gone', CURRENT_TIMESTAMP)`,
    )
    raw.prepare(
      `INSERT INTO messages_fts (message_id, subject, body, from_addr) VALUES (10, 'Deleted edge', 'body', 'x@example.com')`,
    ).run()
    store = openMsgvaultStore(dbPath)
  })

  afterAll(() => raw.close())

  it('FTS syntax characters degrade to empty results instead of throwing', async () => {
    const { searchMessages } = await import('../src/mail/store/msgvaultAdapter.js')
    expect(searchMessages(store.db, 'subject:x')).toEqual([])
    expect(searchMessages(store.db, '-foo OR NEAR(a b)')).toEqual([])
    expect(searchMessages(store.db, 'unbalanced "quote')).toEqual([])
  })

  it('getMessage hides soft-deleted rows', async () => {
    const { getMessage } = await import('../src/mail/store/msgvaultAdapter.js')
    expect(getMessage(store.db, 10)).toBeNull()
  })
})
