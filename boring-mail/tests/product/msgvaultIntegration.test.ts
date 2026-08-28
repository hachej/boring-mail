// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openMsgvaultStore, resolveReplyTarget } from '../../src/mail/store/msgvaultAdapter.js'
import { openProductStore } from '../../src/mail/store/internalProductStore.js'
const schema = readFileSync(new URL('../fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8')
describe('trusted msgvault integration', () => {
  it('keeps read eligibility separate from corrupt send-account identity storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'account-corrupt-')),
      path = join(root, 'product.db'),
      product = openProductStore(path, { now: () => 1, resolveReplyTarget: () => null })
    try {
      product.upsertAccount({
        accountId: 'a', providerSourceId: 1, primaryAddress: 'a@x', sendAs: ['a@x'],
      })
      product.reconcileMsgvaultReadSources([{ sourceId: 1, exactIdentifier: 'a@x', identities: ['alias@x'] }])
      const writer = new DatabaseSync(path)
      writer.prepare(`UPDATE mail_accounts SET send_as_json='[1]' WHERE account_id='a'`).run()
      writer.close()
      expect(product.connectedInboxSources()).toEqual([{ sourceId: 1, identities: ['a@x', 'alias@x'] }])
      expect(() => product.saveDraft({
        kind: 'compose', path: 'x.mail.md', accountId: 'a', sendAsAddress: 'a@x', to: ['b@x'], subject: 's', bodyMarkdown: 'b',
      })).toThrow(/account.send_as must be a string array/)
    } finally {
      product.close()
    }
  })

  it('derives account from selected immutable row even when RFC822 ID is duplicated', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-')),
      path = join(root, 'mv.db'),
      raw = new DatabaseSync(path)
    // This fixture deliberately includes one incoherent ownership row to prove
    // the adapter rejects it rather than relying on provider FK enforcement.
    raw.exec('PRAGMA foreign_keys=OFF')
    raw.exec(schema)
    raw.exec(`
      INSERT INTO sources(id,source_type,identifier) VALUES(42,'gmail','a@x'),(43,'gmail','b@x');
      INSERT INTO conversations(id,source_id,conversation_type) VALUES
        (420,42,'email_thread'),(430,43,'email_thread'),(431,43,'calendar');
      INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type) VALUES
        (1,420,42,'<same@x>','email'),(2,430,43,'<same@x>','email'),
        (3,420,42,'<gone@x>','email'),(4,420,42,'','email'),
        (5,999,42,'<incoherent@x>','email'),(6,431,43,'<calendar@x>','calendar');
      UPDATE messages SET deleted_at='x' WHERE id=3;
    `)
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
      product.reconcileMsgvaultReadSources([
        { sourceId: 42, exactIdentifier: 'a@x', identities: ['alias@x'] },
        { sourceId: 43, exactIdentifier: 'b@x', identities: ['b@x'] },
      ])
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
      expect(resolveReplyTarget(mv.db, 5)).toBeNull()
      expect(resolveReplyTarget(mv.db, 6)).toBeNull()
      expect(() => product.saveDraft({ ...base, path: 'calendar.mail.md', replyToMessageId: 6 })).toThrow(/absent/)
      expect(() => resolveReplyTarget(mv.db, 0)).toThrow(/positive safe integer/)
    } finally {
      product.close()
      mv.db.close()
    }
  })
})
