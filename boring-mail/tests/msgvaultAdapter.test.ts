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
  listUnifiedInbox,
  openMsgvaultStore,
  readRawMessage,
  resolveReplyTarget,
  searchMessages,
} from '../src/mail/store/msgvaultAdapter.js'

const SCHEMA = `
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL,
  identifier TEXT NOT NULL
);
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
  received_at DATETIME,
  internal_date DATETIME,
  sender_id INTEGER REFERENCES participants(id),
  subject TEXT,
  snippet TEXT,
  is_read BOOLEAN DEFAULT TRUE,
  attachment_count INTEGER DEFAULT 0,
  deleted_at DATETIME,
  deleted_from_source_at DATETIME
);
CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);
CREATE TABLE message_recipients (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  participant_id INTEGER,
  recipient_type TEXT NOT NULL,
  display_name TEXT,
  email_address TEXT
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

function mimeMessage(opts: {
  from: string
  to: string
  subject: string
  body: string
  messageId: string
}): Buffer {
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

    db.exec(`INSERT INTO sources (id, source_type, identifier) VALUES (1, 'gmail', 'fixture@example.com')`)
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
    db.exec(
      `INSERT INTO labels (id, source_id, name, label_type) VALUES (1, 1, 'INBOX', 'system'), (2, 1, 'UNREAD', 'system')`,
    )
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

  it('rejects an all-column archive whose trusted messages.id is not the single integer PK', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'msgvault-bad-identity-')), 'bad.db')
    const bad = new DatabaseSync(path)
    bad.exec(
      SCHEMA.replace('id INTEGER PRIMARY KEY,\n  conversation_id', 'id TEXT,\n  conversation_id')
        .replace(/ REFERENCES messages\(id\)( ON DELETE CASCADE)?/g, ''),
    )
    bad.exec(`INSERT INTO sources(id,source_type,identifier) VALUES(1,'gmail','fixture@example.com');
      INSERT INTO conversations(id,source_id,conversation_type) VALUES(1,1,'email_thread');
      INSERT INTO messages(id,conversation_id,source_id) VALUES('duplicate',1,1),('duplicate',1,1)`)
    bad.close()
    expect(() => openMsgvaultStore(path)).toThrow(/messages\.id must have INTEGER affinity and be the single primary key/)
  })

  it('opens read-only and rejects schema drift', async () => {
    const opened = openMsgvaultStore(dbPath)
    expect(opened.db.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 3 })

    const notAnArchive = join(mkdtempSync(join(tmpdir(), 'msgvault-empty-')), 'empty.db')
    const empty = new DatabaseSync(notAnArchive)
    empty.exec('CREATE TABLE other(x)')
    empty.close()
    expect(() => openMsgvaultStore(notAnArchive)).toThrow(/schema drift/)

    const missingJoinColumn = join(mkdtempSync(join(tmpdir(), 'msgvault-column-drift-')), 'drift.db')
    const drift = new DatabaseSync(missingJoinColumn)
    drift.exec(`
      CREATE TABLE messages (id INTEGER, rfc822_message_id TEXT, deleted_at TEXT);
      CREATE TABLE conversations (id INTEGER); CREATE TABLE participants (id INTEGER);
      CREATE TABLE message_labels (id INTEGER); CREATE TABLE labels (id INTEGER);
      CREATE TABLE message_raw (id INTEGER); CREATE TABLE attachments (id INTEGER);
      CREATE TABLE messages_fts (id INTEGER);
    `)
    drift.close()
    expect(() => openMsgvaultStore(missingJoinColumn)).toThrow(/messages missing column\(s\):.*source_id/)

    const missingReferenced = join(mkdtempSync(join(tmpdir(), 'msgvault-all-columns-')), 'drift.db')
    const missingDb = new DatabaseSync(missingReferenced)
    missingDb.exec(SCHEMA.replace('storage_path TEXT NOT NULL', 'storage_path_renamed TEXT NOT NULL'))
    missingDb.close()
    expect(() => openMsgvaultStore(missingReferenced)).toThrow(
      /attachments missing column\(s\): storage_path/,
    )

    const fakeFts = join(mkdtempSync(join(tmpdir(), 'msgvault-fake-fts-')), 'drift.db')
    const fakeDb = new DatabaseSync(fakeFts)
    fakeDb.exec(
      SCHEMA.replace(
        /CREATE VIRTUAL TABLE messages_fts[\s\S]*?\);/,
        'CREATE TABLE messages_fts(message_id INTEGER, subject TEXT);',
      ),
    )
    fakeDb.close()
    expect(() => openMsgvaultStore(fakeFts)).toThrow(/not an FTS5 virtual table/)

    const scopedIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-index-drift-')), 'drift.db')
    const scopedIndex = new DatabaseSync(scopedIndexPath)
    scopedIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(source_id,rfc822_message_id);',
    ))
    scopedIndex.close()
    expect(() => openMsgvaultStore(scopedIndexPath)).toThrow(
      /global index idx_messages_rfc822_message_id\(rfc822_message_id\)/,
    )

    const missingRecipientsPath = join(mkdtempSync(join(tmpdir(), 'msgvault-recipient-drift-')), 'drift.db')
    const missingRecipients = new DatabaseSync(missingRecipientsPath)
    missingRecipients.exec(SCHEMA.replace('recipient_type TEXT NOT NULL,', 'recipient_kind TEXT NOT NULL,'))
    missingRecipients.close()
    expect(() => openMsgvaultStore(missingRecipientsPath)).toThrow(
      /message_recipients missing column\(s\): recipient_type/,
    )
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

  it('resolves immutable message row ownership and verifies exact pairs', () => {
    expect(resolveReplyTarget(store.db, 2)).toEqual({ rfc822MessageId: '<q2@example.com>', sourceId: 1 })
    expect(resolveReplyTarget(store.db, 3)).toBeNull()
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

describe('msgvaultAdapter — unified inbox projection', () => {
  let raw: DatabaseSync
  let store: { db: DatabaseSync }

  beforeAll(() => {
    const path = join(mkdtempSync(join(tmpdir(), 'msgvault-unified-')), 'fixture.db')
    raw = new DatabaseSync(path)
    raw.exec(SCHEMA)
    raw.exec(`
      INSERT INTO sources(id,source_type,identifier) VALUES
        (1,'gmail','owner-a@example.com'),
        (2,'gmail','owner-b@example.com'),
        (3,'gmail','owner-c@example.com');
      INSERT INTO conversations(id,source_id,source_conversation_id,conversation_type) VALUES
        (11,1,'a-1','email_thread'), (12,2,'b-1','email_thread'),
        (13,3,'c-1','email_thread'), (14,1,'a-2','email_thread'),
        (15,2,'b-2','email_thread'), (16,3,'c-2','email_thread');
    `)
    const insert = raw.prepare(`INSERT INTO messages(
      id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,
      is_read,attachment_count,deleted_at,deleted_from_source_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    const message = (
      id: number,
      conversationId: number,
      sourceId: number,
      rfc822: string | null,
      sentAt: string,
      subject: string,
      deletedAt: string | null = null,
      deletedFromSourceAt: string | null = null,
      messageType = 'email',
    ) => insert.run(
      id, conversationId, sourceId, rfc822, messageType, sentAt, subject,
      id === 102 ? 0 : 1, id === 401 ? 1 : 0, deletedAt, deletedFromSourceAt,
    )

    // Addressed source 2 wins even though source 1 has the newer copy.
    message(101, 11, 1, '<addressed@example.com>', '2030-01-08 00:00:00', 'newer copy')
    message(102, 12, 2, '<addressed@example.com>', '2030-01-07 00:00:00', 'addressed copy')
    raw.exec(`INSERT INTO message_recipients(message_id,recipient_type,email_address)
      VALUES(102,'To','OWNER-B@example.com'),(101,'bcc','owner-a@example.com')`)

    // No addressed account: newest copy wins, then source id is the stable tie-break.
    message(201, 12, 2, '<newest@example.com>', '2030-01-05 00:00:00', 'older fallback')
    message(202, 13, 3, '<newest@example.com>', '2030-01-06 00:00:00', 'newest fallback')
    message(301, 12, 2, '<stable@example.com>', '2030-01-04 00:00:00', 'source two')
    message(302, 11, 1, '<stable@example.com>', '2030-01-04 00:00:00', 'source one')

    message(401, 14, 1, '<single@example.com>', '2030-01-03 00:00:00', 'singleton')
    message(402, 14, 1, null, '2030-01-02 00:00:00', 'null one')
    message(403, 15, 2, null, '2030-01-01 00:00:00', 'null two')
    message(404, 14, 1, 'not-a-message-id', '2029-12-31 00:00:00', 'invalid one')
    message(405, 15, 2, 'not-a-message-id', '2029-12-30 00:00:00', 'invalid two')

    // Deleted copies neither win nor contribute to coalesced/copyCount.
    message(501, 11, 1, '<local-delete@example.com>', '2031-01-01 00:00:00', 'deleted local', 'gone')
    message(502, 12, 2, '<local-delete@example.com>', '2029-12-29 00:00:00', 'live local peer')
    message(503, 13, 3, '<provider-delete@example.com>', '2031-01-01 00:00:00', 'deleted provider', null, 'gone')
    message(504, 16, 3, '<provider-delete@example.com>', '2029-12-28 00:00:00', 'live provider peer')
    message(505, 11, 1, '<gone@example.com>', '2032-01-01 00:00:00', 'gone entirely', null, 'gone')
    message(506, 11, 1, '<calendar@example.com>', '2032-01-01 00:00:00', 'not email', null, null, 'calendar')
    store = openMsgvaultStore(path)
  })

  afterAll(() => raw.close())

  it('coalesces live copies globally and selects addressed reply ownership', () => {
    const items = listUnifiedInbox(store.db, { limit: 20 })
    const addressed = items.find((item) => item.rfc822MessageId === '<addressed@example.com>')
    expect(addressed).toMatchObject({
      messageId: 102,
      conversationId: 12,
      sourceId: 2,
      sourceIdentifier: 'owner-b@example.com',
      subject: 'addressed copy',
      unread: true,
      coalesced: true,
      copyCount: 2,
    })
    expect(items.filter((item) => item.rfc822MessageId === '<addressed@example.com>')).toHaveLength(1)
  })

  it('uses newest-copy and stable source-id fallbacks', () => {
    const items = listUnifiedInbox(store.db, { limit: 20 })
    expect(items.find((item) => item.rfc822MessageId === '<newest@example.com>')).toMatchObject({
      messageId: 202,
      conversationId: 13,
      sourceId: 3,
      coalesced: true,
    })
    expect(items.find((item) => item.rfc822MessageId === '<stable@example.com>')).toMatchObject({
      messageId: 302,
      conversationId: 11,
      sourceId: 1,
      coalesced: true,
    })
  })

  it('keeps singleton, null and invalid identities distinct', () => {
    const items = listUnifiedInbox(store.db, { limit: 20 })
    expect(items.find((item) => item.messageId === 401)).toMatchObject({
      rfc822MessageId: '<single@example.com>', coalesced: false, copyCount: 1, hasAttachments: true,
    })
    expect(items.filter((item) => item.messageId === 402 || item.messageId === 403)).toHaveLength(2)
    expect(items.filter((item) => item.messageId === 404 || item.messageId === 405)).toHaveLength(2)
    for (const id of [402, 403, 404, 405]) {
      expect(items.find((item) => item.messageId === id)).toMatchObject({
        rfc822MessageId: null, coalesced: false, copyCount: 1,
      })
    }
  })

  it('excludes both deletion forms and paginates in deterministic order', () => {
    const all = listUnifiedInbox(store.db, { limit: 20 })
    expect(all.map((item) => item.messageId)).toEqual([
      102, 202, 302, 401, 402, 403, 404, 405, 502, 504,
    ])
    expect(all.find((item) => item.messageId === 502)).toMatchObject({ coalesced: false, copyCount: 1 })
    expect(all.find((item) => item.messageId === 504)).toMatchObject({ coalesced: false, copyCount: 1 })
    expect(listUnifiedInbox(store.db, { limit: 3, offset: 2 })).toEqual(all.slice(2, 5))
    expect(() => listUnifiedInbox(store.db, { limit: 0 })).toThrow(/limit must be a safe integer/)
    expect(() => listUnifiedInbox(store.db, { limit: 201 })).toThrow(/limit must be a safe integer/)
    expect(() => listUnifiedInbox(store.db, { offset: -1 })).toThrow(/offset must be a safe integer/)
    expect(() => listUnifiedInbox(store.db, { offset: 1_000_001 })).toThrow(/offset must be a safe integer/)
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
    raw.exec(`INSERT INTO sources (id, source_type, identifier) VALUES (1, 'gmail', 'edge@example.com')`)
    raw.exec(`INSERT INTO participants (id, email_address, display_name) VALUES (1, 'x@example.com', 'X')`)
    raw.exec(
      `INSERT INTO conversations (id, source_id, source_conversation_id, conversation_type, title)
       VALUES (1, 1, 't1', 'email_thread', 'Edge')`,
    )
    raw.exec(
      `INSERT INTO messages (id, conversation_id, source_id, rfc822_message_id, subject, snippet, deleted_at)
       VALUES (10, 1, 1, '<e1@example.com>', 'Deleted edge', 'gone', CURRENT_TIMESTAMP)`,
    )
    raw
      .prepare(
        `INSERT INTO messages_fts (message_id, subject, body, from_addr) VALUES (10, 'Deleted edge', 'body', 'x@example.com')`,
      )
      .run()
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
