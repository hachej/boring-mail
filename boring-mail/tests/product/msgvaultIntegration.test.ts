// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { hasMessageAtSource, openMsgvaultStore } from '../../src/mail/store/msgvaultAdapter.js'
import { openProductStore } from '../../src/mail/store/productDb.js'

function createMsgvaultFixture(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, rfc822_message_id TEXT, source_id INTEGER, deleted_at TEXT
    );
    CREATE TABLE conversations (id INTEGER); CREATE TABLE participants (id INTEGER);
    CREATE TABLE message_labels (id INTEGER); CREATE TABLE labels (id INTEGER);
    CREATE TABLE message_raw (id INTEGER); CREATE TABLE attachments (id INTEGER);
    CREATE TABLE messages_fts (id INTEGER);
    INSERT INTO messages VALUES (1, '<trusted@example.net>', 42, NULL);
    INSERT INTO messages VALUES (2, '<deleted@example.net>', 42, '2027-01-01');
  `)
  db.close()
}

describe('ProductStore + msgvault ownership boundary', () => {
  it('uses the real guarded msgvault lookup for exact live rfc822+source ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'product-msgvault-'))
    const archivePath = join(root, 'msgvault.db')
    createMsgvaultFixture(archivePath)
    const archive = openMsgvaultStore(archivePath)
    const product = openProductStore(join(root, 'product.db'), {
      now: () => 1_800_000_000_000,
      verifyReplyOwnership: (messageId, sourceId) => hasMessageAtSource(archive.db, messageId, sourceId),
    })
    product.upsertAccount({
      accountId: 'trusted', providerSourceId: 42,
      primaryAddress: 'sender@example.com', sendAs: ['sender@example.com'],
    })
    const base = {
      path: 'drafts/reply.mail.md', accountId: 'trusted', sendAsAddress: 'sender@example.com',
      to: ['recipient@example.net'], subject: 'reply', bodyMarkdown: 'body',
    }
    expect(product.saveDraft({
      ...base, reply: { rfc822MessageId: '<trusted@example.net>', sourceId: 42 },
    })).toMatchObject({ reply: { sourceId: 42 } })
    expect(() => product.saveDraft({
      ...base, path: 'drafts/spoof.mail.md',
      reply: { rfc822MessageId: '<trusted@example.net>', sourceId: 41 },
    })).toThrow(/trusted msgvault/)
    expect(() => product.saveDraft({
      ...base, path: 'drafts/deleted.mail.md',
      reply: { rfc822MessageId: '<deleted@example.net>', sourceId: 42 },
    })).toThrow(/trusted msgvault/)
    product.close()
    archive.db.close()
  })
})
