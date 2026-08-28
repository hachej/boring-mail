// bm-zf6 — adapter tests run against a SYNTHETIC msgvault fixture (schema-faithful
// subset, zlib raw MIME). No personal data is ever committed.
// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  attachmentAbsolutePath,
  correlatableMessageId,
  getThreadMessages,
  hasMessageAtSource,
  listAttachments,
  listThreads,
  openMsgvaultStore,
  readRawMessage,
  resolveReplyTarget,
  searchMessages,
} from '../src/mail/store/msgvaultAdapter.js'

const SCHEMA = readFileSync(new URL('./fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8')

interface TableColumn { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
interface ForeignKey { table: string; from: string; to: string; on_update: string; on_delete: string; match: string }
const UPSTREAM_V0193_REQUIRED_COLUMNS: Record<string, string[]> = {
  sources: ['id', 'source_type', 'identifier'],
  participants: ['id', 'email_address', 'display_name', 'domain'],
  conversations: ['id', 'source_id', 'source_conversation_id', 'conversation_type', 'title', 'message_count', 'unread_count', 'last_message_at', 'last_message_preview'],
  messages: ['id', 'conversation_id', 'source_id', 'rfc822_message_id', 'message_type', 'sent_at', 'received_at', 'internal_date', 'sender_id', 'subject', 'snippet', 'is_read', 'attachment_count', 'deleted_at', 'deleted_from_source_at'],
  account_identities: ['source_id', 'address', 'source_signal', 'confirmed_at'],
  message_bodies: ['message_id', 'body_text', 'body_html'],
  message_recipients: ['id', 'message_id', 'participant_id', 'recipient_type', 'display_name', 'email_address'],
  labels: ['id', 'source_id', 'name'],
  message_labels: ['message_id', 'label_id'],
  message_raw: ['message_id', 'raw_data', 'raw_format', 'compression'],
  attachments: ['id', 'message_id', 'filename', 'mime_type', 'size', 'content_hash', 'storage_path'],
  messages_fts: ['message_id'],
}
const UPSTREAM_V0193_REQUIRED_PRIMARY_KEYS: Record<string, Array<{ name: string; pk: number }>> = {
  sources: [{ name: 'id', pk: 1 }],
  participants: [{ name: 'id', pk: 1 }],
  conversations: [{ name: 'id', pk: 1 }],
  messages: [{ name: 'id', pk: 1 }],
  account_identities: [{ name: 'source_id', pk: 1 }, { name: 'address', pk: 2 }],
  message_bodies: [{ name: 'message_id', pk: 1 }],
  message_recipients: [{ name: 'id', pk: 1 }],
  labels: [{ name: 'id', pk: 1 }],
  message_labels: [{ name: 'message_id', pk: 1 }, { name: 'label_id', pk: 2 }],
  message_raw: [{ name: 'message_id', pk: 1 }],
  attachments: [{ name: 'id', pk: 1 }],
}
const UPSTREAM_V0193_REQUIRED_FOREIGN_KEYS: Record<string, ForeignKey[]> = {
  conversations: [{ table: 'sources', from: 'source_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' }],
  messages: [
    { table: 'participants', from: 'sender_id', to: 'id', on_update: 'NO ACTION', on_delete: 'NO ACTION', match: 'NONE' },
    { table: 'sources', from: 'source_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
    { table: 'conversations', from: 'conversation_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
  ],
  account_identities: [{ table: 'sources', from: 'source_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' }],
  message_bodies: [{ table: 'messages', from: 'message_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' }],
  message_recipients: [
    { table: 'participants', from: 'participant_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
    { table: 'messages', from: 'message_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
  ],
  labels: [{ table: 'sources', from: 'source_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' }],
  message_labels: [
    { table: 'labels', from: 'label_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
    { table: 'messages', from: 'message_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
  ],
  message_raw: [{ table: 'messages', from: 'message_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' }],
  attachments: [{ table: 'messages', from: 'message_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' }],
}

function tableColumns(db: DatabaseSync, table: string): TableColumn[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableColumn[]
}
function tableForeignKeys(db: DatabaseSync, table: string): ForeignKey[] {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as Array<ForeignKey & { id: number; seq: number }>)
    .sort((left, right) => left.from.localeCompare(right.from))
    .map(({ table, from, to, on_update, on_delete, match }) => ({ table, from, to, on_update, on_delete, match }))
}

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
         2, 1, '2026-08-20 12:00:00+00:00', 'see attached numbers')`,
    )
    db.exec(
      `INSERT INTO messages (id, conversation_id, source_id, source_message_id, rfc822_message_id,
        message_type, sent_at, sender_id, subject, snippet, is_read)
       VALUES
        (1, 1, 1, 'gmsg_1', '<q1@example.com>', 'email', '2026-08-19 09:00:00+00:00', 2, 'Quarterly report', 'here are the numbers', 1),
        (2, 1, 1, 'gmsg_2', '<q2@example.com>', 'email', '2026-08-20 12:00:00+00:00', 1, 'Re: Quarterly report', 'see attached numbers', 0)`,
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
      `INSERT INTO messages (id, conversation_id, source_id, source_message_id, rfc822_message_id, message_type, subject, deleted_at)
       VALUES (3, 2, 1, 'gmsg_3', '<d@example.com>', 'email', 'Deleted thing', CURRENT_TIMESTAMP)`,
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
      INSERT INTO messages(id,conversation_id,source_id,message_type) VALUES('duplicate',1,1,'email'),('duplicate',1,1,'email')`)
    bad.close()
    expect(() => openMsgvaultStore(path)).toThrow(/messages\.id must have INTEGER affinity and be the single primary key/)
  })

  it('rejects duplicate-participant schemas by requiring participants.id as the single integer PK', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'msgvault-duplicate-participants-')), 'bad.db')
    const bad = new DatabaseSync(path)
    bad.exec(SCHEMA
      .replace('CREATE TABLE participants (\n  id INTEGER PRIMARY KEY,', 'CREATE TABLE participants (\n  id INTEGER,')
      .replace(/sender_id INTEGER REFERENCES participants\(id\),/g, 'sender_id INTEGER,')
      .replace(/participant_id INTEGER NOT NULL REFERENCES participants\(id\) ON DELETE CASCADE,/g, 'participant_id INTEGER NOT NULL,'))
    bad.exec(`INSERT INTO participants(id,email_address,display_name) VALUES(1,'a@example.invalid','A'),(1,'b@example.invalid','B')`)
    bad.close()
    expect(() => openMsgvaultStore(path)).toThrow(/participants\.id must have INTEGER affinity and be the single primary key/)
  })

  it('keeps the committed msgvault v0.19.3 fixture structurally equivalent for required tables and FKs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'msgvault-committed-v0193-')), 'fixture.db')
    const genuine = new DatabaseSync(path)
    genuine.exec(SCHEMA)
    for (const [table, expectedColumns] of Object.entries(UPSTREAM_V0193_REQUIRED_COLUMNS)) {
      const columns = tableColumns(genuine, table)
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(expectedColumns))
    }
    for (const [table, expectedPrimaryKeys] of Object.entries(UPSTREAM_V0193_REQUIRED_PRIMARY_KEYS)) {
      expect(tableColumns(genuine, table).filter((column) => column.pk > 0).map((column) => ({
        name: column.name,
        pk: column.pk,
      }))).toEqual(expectedPrimaryKeys)
    }
    for (const [table, expectedForeignKeys] of Object.entries(UPSTREAM_V0193_REQUIRED_FOREIGN_KEYS)) {
      expect(tableForeignKeys(genuine, table)).toEqual(expectedForeignKeys.sort((left, right) => left.from.localeCompare(right.from)))
    }
    genuine.close()
    const opened = openMsgvaultStore(path)
    opened.db.close()
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
      /non-unique, non-partial ASC index exactly on rfc822_message_id/,
    )

    const uniqueIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-unique-index-')), 'drift.db')
    const uniqueIndex = new DatabaseSync(uniqueIndexPath)
    uniqueIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
      'CREATE UNIQUE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
    ))
    uniqueIndex.close()
    expect(() => openMsgvaultStore(uniqueIndexPath)).toThrow(/non-unique, non-partial ASC index exactly on rfc822_message_id/)

    const extraColumnIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-extra-index-column-')), 'drift.db')
    const extraColumnIndex = new DatabaseSync(extraColumnIndexPath)
    extraColumnIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
      'CREATE INDEX renamed_global_correlation ON messages(rfc822_message_id,source_id);',
    ))
    extraColumnIndex.close()
    expect(() => openMsgvaultStore(extraColumnIndexPath)).toThrow(/exactly on rfc822_message_id/)

    const collatedIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-collated-index-')), 'drift.db')
    const collatedIndex = new DatabaseSync(collatedIndexPath)
    collatedIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id COLLATE NOCASE);',
    ))
    collatedIndex.close()
    expect(() => openMsgvaultStore(collatedIndexPath)).toThrow(/exactly on rfc822_message_id/)

    const wrongConversationDirectionPath = join(mkdtempSync(join(tmpdir(), 'msgvault-conversation-index-direction-')), 'drift.db')
    const wrongConversationDirection = new DatabaseSync(wrongConversationDirectionPath)
    wrongConversationDirection.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_conversation ON messages(conversation_id, sent_at DESC);',
      'CREATE INDEX idx_messages_conversation ON messages(conversation_id, sent_at ASC);',
    ))
    wrongConversationDirection.close()
    expect(() => openMsgvaultStore(wrongConversationDirectionPath)).toThrow(/conversation_id ASC,sent_at DESC/)

    const renamedEquivalentIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-equivalent-index-')), 'ok.db')
    const renamedEquivalentIndex = new DatabaseSync(renamedEquivalentIndexPath)
    renamedEquivalentIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);',
      'CREATE INDEX renamed_global_correlation ON messages(rfc822_message_id);',
    ))
    renamedEquivalentIndex.close()
    const equivalentStore = openMsgvaultStore(renamedEquivalentIndexPath)
    equivalentStore.db.close()

    const missingLiveIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-live-index-')), 'drift.db')
    const missingLiveIndex = new DatabaseSync(missingLiveIndexPath)
    missingLiveIndex.exec(SCHEMA.replace(
      /CREATE INDEX idx_messages_live_sent_at[\s\S]*?deleted_from_source_at IS NULL;/,
      '',
    ))
    missingLiveIndex.close()
    expect(() => openMsgvaultStore(missingLiveIndexPath)).toThrowError(
      expect.objectContaining({ code: 'unsupported_schema', message: expect.stringMatching(/REMEDIATION:.*live rows/) }),
    )

    const scopedLiveIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-scoped-live-index-')), 'drift.db')
    const scopedLiveIndex = new DatabaseSync(scopedLiveIndexPath)
    scopedLiveIndex.exec(SCHEMA.replace(
      'WHERE deleted_at IS NULL AND deleted_from_source_at IS NULL;',
      'WHERE deleted_at IS NULL AND deleted_from_source_at IS NULL AND source_id=1;',
    ))
    scopedLiveIndex.close()
    expect(() => openMsgvaultStore(scopedLiveIndexPath)).toThrow(/live rows/)

    for (const table of ['sources', 'conversations'] as const) {
      const duplicateKeyPath = join(mkdtempSync(join(tmpdir(), `msgvault-${table}-identity-`)), 'drift.db')
      const duplicateKey = new DatabaseSync(duplicateKeyPath)
      const tableStart = `CREATE TABLE ${table} (\n  id INTEGER PRIMARY KEY,`
      duplicateKey.exec(SCHEMA.replace(tableStart, `CREATE TABLE ${table} (\n  id INTEGER,`))
      duplicateKey.close()
      expect(() => openMsgvaultStore(duplicateKeyPath)).toThrow(
        new RegExp(`${table}\\.id must have INTEGER affinity and be the single primary key`),
      )
    }

    const missingSourceIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-source-index-')), 'drift.db')
    const missingSourceIndex = new DatabaseSync(missingSourceIndexPath)
    missingSourceIndex.exec(SCHEMA.replace('CREATE INDEX idx_messages_source ON messages(source_id);', ''))
    missingSourceIndex.close()
    expect(() => openMsgvaultStore(missingSourceIndexPath)).toThrow(/ASC index exactly on source_id/)

    const missingRecipientIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-recipient-index-')), 'drift.db')
    const missingRecipientIndex = new DatabaseSync(missingRecipientIndexPath)
    missingRecipientIndex.exec(SCHEMA.replace(
      'CREATE INDEX idx_message_recipients_message ON message_recipients(message_id);',
      '',
    ))
    missingRecipientIndex.close()
    expect(() => openMsgvaultStore(missingRecipientIndexPath)).toThrow(
      /message_recipients requires a non-unique, non-partial ASC index exactly on message_id/,
    )

    const missingAttachmentIndexPath = join(mkdtempSync(join(tmpdir(), 'msgvault-attachment-index-')), 'drift.db')
    const missingAttachmentIndex = new DatabaseSync(missingAttachmentIndexPath)
    missingAttachmentIndex.exec(SCHEMA.replace('CREATE INDEX idx_attachments_message ON attachments(message_id);', ''))
    missingAttachmentIndex.close()
    expect(() => openMsgvaultStore(missingAttachmentIndexPath)).toThrow(
      /attachments requires a non-unique, non-partial ASC index exactly on message_id/,
    )

    const missingRecipientParticipantFkPath = join(mkdtempSync(join(tmpdir(), 'msgvault-recipient-participant-fk-')), 'drift.db')
    const missingRecipientParticipantFk = new DatabaseSync(missingRecipientParticipantFkPath)
    missingRecipientParticipantFk.exec(SCHEMA.replace(
      'participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,',
      'participant_id INTEGER NOT NULL,',
    ))
    missingRecipientParticipantFk.close()
    expect(() => openMsgvaultStore(missingRecipientParticipantFkPath)).toThrow(
      /message_recipients\.participant_id must be an exact single-column foreign key to participants\(id\) ON UPDATE NO ACTION ON DELETE CASCADE/,
    )

    const participantPkPath = join(mkdtempSync(join(tmpdir(), 'msgvault-participant-pk-')), 'drift.db')
    const participantPk = new DatabaseSync(participantPkPath)
    participantPk.exec(SCHEMA.replace('CREATE TABLE participants (\n  id INTEGER PRIMARY KEY,', 'CREATE TABLE participants (\n  id INTEGER,'))
    participantPk.close()
    expect(() => openMsgvaultStore(participantPkPath)).toThrow(/participants\.id must have INTEGER affinity and be the single primary key/)

    const senderFkPath = join(mkdtempSync(join(tmpdir(), 'msgvault-sender-fk-')), 'drift.db')
    const senderFk = new DatabaseSync(senderFkPath)
    senderFk.exec(SCHEMA.replace('sender_id INTEGER REFERENCES participants(id),', 'sender_id INTEGER,'))
    senderFk.close()
    expect(() => openMsgvaultStore(senderFkPath)).toThrow(/messages\.sender_id must be an exact single-column foreign key to participants\(id\) ON UPDATE NO ACTION ON DELETE NO ACTION/)

    const cascadingSenderFkPath = join(mkdtempSync(join(tmpdir(), 'msgvault-sender-fk-action-')), 'drift.db')
    const cascadingSenderFk = new DatabaseSync(cascadingSenderFkPath)
    cascadingSenderFk.exec(SCHEMA.replace(
      'sender_id INTEGER REFERENCES participants(id),',
      'sender_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,',
    ))
    cascadingSenderFk.close()
    expect(() => openMsgvaultStore(cascadingSenderFkPath)).toThrow(/ON UPDATE NO ACTION ON DELETE NO ACTION/)

    const bodyFkPath = join(mkdtempSync(join(tmpdir(), 'msgvault-body-fk-')), 'drift.db')
    const bodyFk = new DatabaseSync(bodyFkPath)
    bodyFk.exec(SCHEMA.replace('message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,', 'message_id INTEGER PRIMARY KEY,'))
    bodyFk.close()
    expect(() => openMsgvaultStore(bodyFkPath)).toThrow(/message_bodies\.message_id must be an exact single-column foreign key to messages\(id\) ON UPDATE NO ACTION ON DELETE CASCADE/)

    const missingRecipientsPath = join(mkdtempSync(join(tmpdir(), 'msgvault-recipient-drift-')), 'drift.db')
    const missingRecipients = new DatabaseSync(missingRecipientsPath)
    missingRecipients.exec(SCHEMA.replace('recipient_type TEXT NOT NULL,', 'recipient_kind TEXT NOT NULL,'))
    missingRecipients.close()
    expect(() => openMsgvaultStore(missingRecipientsPath)).toThrow(
      /message_recipients missing column\(s\): recipient_type/,
    )

    const missingRecipientDisplayNamePath = join(mkdtempSync(join(tmpdir(), 'msgvault-recipient-display-name-')), 'drift.db')
    const missingRecipientDisplayName = new DatabaseSync(missingRecipientDisplayNamePath)
    missingRecipientDisplayName.exec(SCHEMA.replace('  display_name TEXT,\n  email_address TEXT', '  email_address TEXT'))
    missingRecipientDisplayName.close()
    expect(() => openMsgvaultStore(missingRecipientDisplayNamePath)).toThrow(
      /message_recipients missing column\(s\): display_name/,
    )

    for (const table of ['message_recipients', 'attachments'] as const) {
      const path = join(mkdtempSync(join(tmpdir(), `msgvault-${table}-pk-`)), 'drift.db')
      const db = new DatabaseSync(path)
      db.exec(SCHEMA.replace(`CREATE TABLE ${table} (\n  id INTEGER PRIMARY KEY,`, `CREATE TABLE ${table} (\n  id INTEGER,`))
      db.close()
      expect(() => openMsgvaultStore(path)).toThrow(
        new RegExp(`${table}\\.id must have INTEGER affinity and be the single primary key`),
      )
    }
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
      '<<a@b>>', '<a b@c>', '<a\tb@c>', '<a\u0001b@c>', '<a,b@c>',
      '<a..b@c>', '<a.@c>', '<a@-c>', '<a@c->', '<a@c..d>', '<é@x>', '<漢@x>', '<😀@x>',
      `<${'x'.repeat(997)}@x>`,
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
      `INSERT INTO messages (id, conversation_id, source_id, rfc822_message_id, message_type, subject, snippet, deleted_at)
       VALUES (10, 1, 1, '<e1@example.com>', 'email', 'Deleted edge', 'gone', CURRENT_TIMESTAMP)`,
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
