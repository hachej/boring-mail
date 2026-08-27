// bm-zf6 — adapter tests run against a SYNTHETIC msgvault fixture (schema-faithful
// subset, zlib raw MIME). No personal data is ever committed.
// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  attachmentAbsolutePath,
  correlatableMessageId,
  explainUnifiedInboxQueryPlan,
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
CREATE INDEX idx_messages_live_sent_at
  ON messages(COALESCE(sent_at, received_at, internal_date) DESC, id DESC)
  WHERE deleted_at IS NULL AND deleted_from_source_at IS NULL;
CREATE TABLE message_recipients (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  participant_id INTEGER,
  recipient_type TEXT NOT NULL,
  display_name TEXT,
  email_address TEXT
);
CREATE INDEX idx_message_recipients_message ON message_recipients(message_id);
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
      /non-unique, non-partial index led by rfc822_message_id/,
    )

    const uniqueIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-unique-index-')), 'drift.db')
    const uniqueIndex = new DatabaseSync(uniqueIndexPath)
    uniqueIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
      'CREATE UNIQUE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
    ))
    uniqueIndex.close()
    expect(() => openMsgvaultStore(uniqueIndexPath)).toThrow(/non-unique, non-partial index/)

    const equivalentIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-equivalent-index-')), 'ok.db')
    const equivalentIndex = new DatabaseSync(equivalentIndexPath)
    equivalentIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
      'CREATE INDEX renamed_global_correlation ON messages(rfc822_message_id,source_id);',
    ))
    equivalentIndex.close()
    const equivalentStore = openMsgvaultStore(equivalentIndexPath)
    equivalentStore.db.close()

    const missingLiveIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-live-index-')), 'drift.db')
    const missingLiveIndex = new DatabaseSync(missingLiveIndexPath)
    missingLiveIndex.exec(SCHEMA.replace(
      /CREATE INDEX idx_messages_live_sent_at[\s\S]*?deleted_from_source_at IS NULL;/,
      '',
    ))
    missingLiveIndex.close()
    expect(() => openMsgvaultStore(missingLiveIndexPath)).toThrow(/live recency index/)

    const missingRecipientIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-recipient-index-')), 'drift.db')
    const missingRecipientIndex = new DatabaseSync(missingRecipientIndexPath)
    missingRecipientIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_message_recipients_message ON message_recipients(message_id);',
      '',
    ))
    missingRecipientIndex.close()
    expect(() => openMsgvaultStore(missingRecipientIndexPath)).toThrow(
      /message_recipients requires a non-partial index led by message_id/,
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

  it('uses one conservative Message-ID contract for correlation and replies', () => {
    expect(correlatableMessageId('<local@example.com>')).toBe('<local@example.com>')
    for (const invalid of [
      null, '', 'bare@example.com', '<@example.com>', '<local@>', '<a@b@c>',
      '<<a@b>>', '<a b@c>', '<a\tb@c>', '<a\u0001b@c>', `<${'x'.repeat(997)}@x>`,
    ]) expect(correlatableMessageId(invalid)).toBeNull()
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
  const eligible = [
    { sourceId: 1, identities: ['owner-a@example.com', 'alias-a@example.com'] },
    { sourceId: 2, identities: ['owner-b@example.com'] },
  ]
  const authority = { scope: 'fixture-process', secret: randomBytes(32) }

  beforeAll(() => {
    const path = join(mkdtempSync(join(tmpdir(), 'msgvault-unified-')), 'fixture.db')
    raw = new DatabaseSync(path)
    raw.exec(SCHEMA)
    raw.exec(`
      INSERT INTO sources(id,source_type,identifier) VALUES
        (1,'gmail','owner-a@example.com'), (2,'gmail','owner-b@example.com'),
        (3,'gmail','disconnected@example.com'), (4,'gmail','unregistered@example.com');
      INSERT INTO conversations(id,source_id,source_conversation_id,conversation_type) VALUES
        (11,1,'a-1','email_thread'), (12,2,'b-1','email_thread'),
        (13,3,'c-1','email_thread'), (14,4,'d-1','email_thread');
    `)
    const insert = raw.prepare(`INSERT INTO messages(
      id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,
      is_read,attachment_count,deleted_at,deleted_from_source_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    const message = (
      id: number, conversationId: number, sourceId: number, rfc822: string | null,
      sentAt: string | null, subject: string, deletedAt: string | null = null,
      deletedFromSourceAt: string | null = null, messageType = 'email',
    ) => insert.run(
      id, conversationId, sourceId, rfc822, messageType, sentAt, subject,
      id === 101 ? 0 : 1, id === 601 ? 1 : 0, deletedAt, deletedFromSourceAt,
    )

    // Alias-addressed source 1 wins over a newer non-addressed source 2 copy.
    message(101, 11, 1, '<alias@example.com>', '2030-01-07 00:00:00', 'alias owner')
    message(102, 12, 2, '<alias@example.com>', '2030-01-08 00:00:00', 'newer other')
    raw.exec(`INSERT INTO message_recipients(message_id,recipient_type,email_address)
      VALUES(101,'To','ALIAS-A@example.com')`)

    // Cc is addressed; when both copies are addressed, newest addressed wins.
    message(201, 11, 1, '<cc@example.com>', '2030-01-05 00:00:00', 'older cc')
    message(202, 12, 2, '<cc@example.com>', '2030-01-06 00:00:00', 'newer to')
    raw.exec(`INSERT INTO message_recipients(message_id,recipient_type,email_address) VALUES
      (201,'cc','alias-a@example.com'),(202,'TO','owner-b@example.com')`)

    // No addressed account: newest copy wins, then source id is stable.
    message(301, 11, 1, '<newest@example.com>', '2030-01-03 00:00:00', 'older fallback')
    message(302, 12, 2, '<newest@example.com>', '2030-01-04 00:00:00', 'newest fallback')
    message(401, 12, 2, '<stable@example.com>', '2030-01-02 00:00:00', 'source two')
    message(402, 11, 1, '<stable@example.com>', '2030-01-02 00:00:00', 'source one')

    message(601, 11, 1, '<single@example.com>', '2030-01-01 00:00:00', 'singleton')
    message(602, 11, 1, null, '2029-12-31 00:00:00', 'null one')
    message(603, 12, 2, null, '2029-12-30 00:00:00', 'null two')

    // Every unsupported shape remains row-distinct and cannot be a reply target.
    const malformed = [
      'not-an-id', '<@domain>', '<local@>', '<a@b@c>', '<<a@b>>', '<a b@c>', '<a\tb@c>', '<a\u0001b@c>',
    ]
    malformed.forEach((id, index) => {
      message(700 + index * 2, 11, 1, id, `2029-12-${String(20 - index).padStart(2, '0')} 00:00:00`, 'bad a')
      message(701 + index * 2, 12, 2, id, `2029-12-${String(19 - index).padStart(2, '0')} 00:00:00`, 'bad b')
    })

    // Ineligible copies neither win nor count.
    message(501, 11, 1, '<connected@example.com>', '2029-11-01 00:00:00', 'connected')
    message(502, 13, 3, '<connected@example.com>', '2032-01-01 00:00:00', 'disconnected addressed')
    message(503, 14, 4, '<unregistered@example.com>', '2032-01-01 00:00:00', 'unregistered')
    raw.exec(`INSERT INTO message_recipients(message_id,recipient_type,email_address)
      VALUES(502,'to','disconnected@example.com')`)

    // Both deletion forms and non-email rows never surface.
    message(801, 11, 1, '<local-delete@example.com>', '2033-01-01 00:00:00', 'local deleted', 'gone')
    message(802, 12, 2, '<provider-delete@example.com>', '2033-01-01 00:00:00', 'provider deleted', null, 'gone')
    message(803, 11, 1, '<calendar@example.com>', '2033-01-01 00:00:00', 'calendar', null, null, 'calendar')
    store = openMsgvaultStore(path)
  })

  afterAll(() => raw.close())

  it('uses all authorized identities and keeps winner identity fields coherent', () => {
    const items = listUnifiedInbox(store.db, eligible, authority, { limit: 50 }).items
    expect(items.find((item) => item.rfc822MessageId === '<alias@example.com>')).toMatchObject({
      messageId: 101, conversationId: 11, sourceId: 1,
      sourceIdentifier: 'owner-a@example.com', subject: 'alias owner', unread: true,
      coalesced: true, copyCount: 2,
    })
    expect(items.find((item) => item.rfc822MessageId === '<cc@example.com>')).toMatchObject({
      messageId: 202, conversationId: 12, sourceId: 2, coalesced: true, copyCount: 2,
    })
    expect(items.find((item) => item.rfc822MessageId === '<newest@example.com>')).toMatchObject({
      messageId: 302, sourceId: 2, coalesced: true,
    })
    expect(items.find((item) => item.rfc822MessageId === '<stable@example.com>')).toMatchObject({
      messageId: 402, sourceId: 1, coalesced: true,
    })
  })

  it('excludes disconnected/unregistered/deleted copies before selection and counting', () => {
    const items = listUnifiedInbox(store.db, eligible, authority, { limit: 50 }).items
    expect(items.find((item) => item.rfc822MessageId === '<connected@example.com>')).toMatchObject({
      messageId: 501, sourceId: 1, coalesced: false, copyCount: 1,
    })
    expect(items.some((item) => [502, 503, 801, 802, 803].includes(item.messageId))).toBe(false)
  })

  it('keeps null/malformed identities distinct and rejects them as reply targets', () => {
    const items = listUnifiedInbox(store.db, eligible, authority, { limit: 50 }).items
    const ids = [
      602, 603, 700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711, 712, 713, 714, 715,
    ]
    for (const id of ids) {
      expect(items.find((item) => item.messageId === id)).toMatchObject({
        rfc822MessageId: null, coalesced: false, copyCount: 1,
      })
      expect(resolveReplyTarget(store.db, id)).toBeNull()
    }
    expect(hasMessageAtSource(store.db, 'not-an-id', 1)).toBe(false)
    expect(resolveReplyTarget(store.db, 101)).toEqual({ rfc822MessageId: '<alias@example.com>', sourceId: 1 })
  })

  it('uses signed keyset cursors and invalidates mutation, eligibility and process changes', () => {
    const first = listUnifiedInbox(store.db, eligible, authority, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = listUnifiedInbox(store.db, eligible, authority, { limit: 2, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(2)
    expect(second.items.map((item) => item.messageId)).not.toEqual(first.items.map((item) => item.messageId))
    expect(() => listUnifiedInbox(
      store.db, eligible, authority, { cursor: `${first.nextCursor}x` },
    )).toThrow(/signature is invalid/)
    expect(() => listUnifiedInbox(
      store.db, eligible.slice(0, 1), authority, { cursor: first.nextCursor! },
    )).toThrow(/cursor expired/)
    expect(() => listUnifiedInbox(
      store.db, eligible, { scope: 'replacement-process', secret: authority.secret },
      { cursor: first.nextCursor! },
    )).toThrow(/cursor expired/)

    raw.exec(`INSERT INTO messages(
      id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count
    ) VALUES(900,11,1,'<sync@example.com>','email','2035-01-01','sync',1,0)`)
    expect(() => listUnifiedInbox(
      store.db, eligible, authority, { cursor: first.nextCursor! },
    )).toThrow(/cursor expired/)
  })

  it('uses the live-recency index for the production outer page scan', () => {
    const plan = explainUnifiedInboxQueryPlan(store.db, eligible)
    expect(plan.some((detail) => /candidate USING INDEX idx_messages_live_sent_at/.test(detail))).toBe(true)
    expect(plan.some((detail) => /candidate USING (?:COVERING )?INDEX idx_messages_rfc822/.test(detail))).toBe(false)
    const deepPlan = explainUnifiedInboxQueryPlan(store.db, eligible, {
      messageAt: '2029-12-31 00:00:00', messageId: 602,
    })
    expect(deepPlan.some((detail) => /SEARCH candidate USING INDEX idx_messages_live_sent_at/.test(detail))).toBe(true)
  })

  it('fails loudly on malformed storage classes and invalid page input', () => {
    raw.prepare(`INSERT INTO sources(id,source_type,identifier) VALUES(5,'gmail',?)`).run(Buffer.from('bad'))
    raw.exec(`INSERT INTO conversations(id,source_id,conversation_type) VALUES(15,5,'email_thread');
      INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
      VALUES(950,15,5,'<bad-storage@example.com>','email','2036-01-01',1,0)`)
    expect(() => listUnifiedInbox(
      store.db, [{ sourceId: 5, identities: ['bad@example.com'] }], authority,
    )).toThrow(/source_identifier must be non-empty text/)
    expect(() => listUnifiedInbox(store.db, eligible, authority, { limit: 0 })).toThrow(/limit must/)
    expect(() => listUnifiedInbox(store.db, eligible, authority, { limit: 201 })).toThrow(/limit must/)
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
