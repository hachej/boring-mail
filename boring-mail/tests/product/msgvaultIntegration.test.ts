// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openMsgvaultStore, resolveReplyTarget } from '../../src/mail/store/msgvaultAdapter.js'
import { openProductStore } from '../../src/mail/store/productDb.js'
const schema = `CREATE TABLE conversations(id INTEGER,conversation_type TEXT,title TEXT,message_count INTEGER,unread_count INTEGER,last_message_at TEXT,last_message_preview TEXT);CREATE TABLE participants(id INTEGER,email_address TEXT,display_name TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER,source_id INTEGER NOT NULL,rfc822_message_id TEXT,subject TEXT,snippet TEXT,sent_at TEXT,is_read INTEGER,attachment_count INTEGER,sender_id INTEGER,deleted_at TEXT);CREATE TABLE message_labels(message_id INTEGER,label_id INTEGER);CREATE TABLE labels(id INTEGER,name TEXT);CREATE TABLE message_raw(message_id INTEGER,raw_data BLOB,raw_format TEXT,compression TEXT);CREATE TABLE attachments(id INTEGER,message_id INTEGER,filename TEXT,mime_type TEXT,size INTEGER,content_hash TEXT,storage_path TEXT);CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED,subject);`
describe('trusted msgvault integration', () => {
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
      product.upsertAccount({ accountId: 'a', providerSourceId: 42, primaryAddress: 'a@x', sendAs: ['a@x'] })
      product.upsertAccount({ accountId: 'b', providerSourceId: 43, primaryAddress: 'b@x', sendAs: ['b@x'] })
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
      expect(() => resolveReplyTarget(mv.db, 4)).toThrow(/invalid RFC822\/source/)
      expect(() => resolveReplyTarget(mv.db, 5)).toThrow(/invalid RFC822\/source/)
      expect(() => resolveReplyTarget(mv.db, 0)).toThrow(/positive safe integer/)
    } finally {
      product.close()
      mv.db.close()
    }
  })
})
