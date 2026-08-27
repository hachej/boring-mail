// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openMsgvaultStore, resolveReplyTarget } from '../../src/mail/store/msgvaultAdapter.js'
import { openProductStore } from '../../src/mail/store/internalProductStore.js'
const schema = `
CREATE TABLE sources(id INTEGER PRIMARY KEY,source_type TEXT NOT NULL,identifier TEXT NOT NULL);
CREATE TABLE conversations(id INTEGER,source_id INTEGER NOT NULL,conversation_type TEXT,title TEXT,message_count INTEGER,unread_count INTEGER,last_message_at TEXT,last_message_preview TEXT);
CREATE TABLE participants(id INTEGER,email_address TEXT,display_name TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER,source_id INTEGER NOT NULL,rfc822_message_id TEXT,message_type TEXT NOT NULL DEFAULT 'email',subject TEXT,snippet TEXT,sent_at TEXT,received_at TEXT,internal_date TEXT,is_read INTEGER,attachment_count INTEGER,sender_id INTEGER,deleted_at TEXT,deleted_from_source_at TEXT);
CREATE INDEX idx_messages_rfc822_message_id ON messages(rfc822_message_id);
CREATE INDEX idx_messages_live_sent_at ON messages(COALESCE(sent_at,received_at,internal_date) DESC,id DESC) WHERE deleted_at IS NULL AND deleted_from_source_at IS NULL;
CREATE TABLE message_recipients(message_id INTEGER NOT NULL,recipient_type TEXT NOT NULL,email_address TEXT);
CREATE INDEX idx_message_recipients_message ON message_recipients(message_id);
CREATE TABLE message_labels(message_id INTEGER,label_id INTEGER);
CREATE TABLE labels(id INTEGER,name TEXT);
CREATE TABLE message_raw(message_id INTEGER,raw_data BLOB,raw_format TEXT,compression TEXT);
CREATE TABLE attachments(id INTEGER,message_id INTEGER,filename TEXT,mime_type TEXT,size INTEGER,content_hash TEXT,storage_path TEXT);
CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED,subject);
`
describe('trusted msgvault integration', () => {
  it('fails closed when connected-account identity storage is semantically corrupt', () => {
    const root = mkdtempSync(join(tmpdir(), 'account-corrupt-')),
      path = join(root, 'product.db'),
      product = openProductStore(path, { now: () => 1, resolveReplyTarget: () => null })
    try {
      product.upsertAccount({
        accountId: 'a', providerSourceId: 1, primaryAddress: 'a@x', sendAs: ['a@x'],
      })
      const writer = new DatabaseSync(path)
      writer.prepare(`UPDATE mail_accounts SET send_as_json='[1]' WHERE account_id='a'`).run()
      writer.close()
      expect(() => product.connectedInboxSources()).toThrow(/send-as identities are invalid/)
    } finally {
      product.close()
    }
  })

  it('derives account from selected immutable row even when RFC822 ID is duplicated', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-')),
      path = join(root, 'mv.db'),
      raw = new DatabaseSync(path)
    raw.exec(schema)
    raw.exec(
      `INSERT INTO messages(id,source_id,rfc822_message_id)VALUES(1,42,'<same@x>'),(2,43,'<same@x>'),(3,42,'<gone@x>'),(4,42,''),(5,'bad','<bad@x>');UPDATE messages SET deleted_at='x' WHERE id=3`,
    )
    raw.close()
    const mv = openMsgvaultStore(path),
      product = openProductStore(join(root, 'product.db'), {
        now: () => 1,
        resolveReplyTarget: (id) => resolveReplyTarget(mv.db, id),
      })
    try {
      product.upsertAccount({
        accountId: 'a', providerSourceId: 42, primaryAddress: 'a@x', sendAs: ['alias@x'],
      })
      product.upsertAccount({
        accountId: 'b', providerSourceId: 43, primaryAddress: 'b@x', sendAs: ['b@x'],
      })
      product.upsertAccount({
        accountId: 'c', providerSourceId: 44, primaryAddress: 'c@x', sendAs: ['c@x'], connected: false,
      })
      expect(product.connectedInboxSources()).toEqual([
        { sourceId: 42, identities: ['a@x', 'alias@x'] },
        { sourceId: 43, identities: ['b@x'] },
      ])
      const base = {
        kind: 'reply' as const,
        path: 'a.mail.md',
        replyToMessageId: 1,
        sendAsAddress: 'a@x',
        to: ['z@x'],
        subject: 's',
        bodyMarkdown: 'b',
      }
      expect(product.saveDraft(base)).toMatchObject({ accountId: 'a', reply: { messageId: 1, sourceId: 42 } })
      expect(
        product.saveDraft({ ...base, path: 'b.mail.md', replyToMessageId: 2, sendAsAddress: 'b@x' }),
      ).toMatchObject({ accountId: 'b' })
      expect(() => product.saveDraft({ ...base, path: 'gone.mail.md', replyToMessageId: 3 })).toThrow(/absent/)
      expect(resolveReplyTarget(mv.db, 4)).toBeNull()
      expect(() => resolveReplyTarget(mv.db, 5)).toThrow(/invalid source id/)
      expect(() => resolveReplyTarget(mv.db, 0)).toThrow(/positive safe integer/)
    } finally {
      product.close()
      mv.db.close()
    }
  })
})
