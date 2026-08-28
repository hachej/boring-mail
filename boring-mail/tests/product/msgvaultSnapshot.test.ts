// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openProductStore } from '../../src/mail/store/internalProductStore.js'
import { openMsgvaultStore } from '../../src/mail/store/msgvaultAdapter.js'
import { listUnifiedInboxWithReconciledSnapshot } from '../../src/mail/store/product/msgvaultSnapshot.js'

const schema = readFileSync(new URL('../fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8')

describe('worker-owned msgvault snapshot orchestration', () => {
  it('fails stale instead of mixing catalog identities with a concurrent WAL page', () => {
    const root = mkdtempSync(join(tmpdir(), 'msgvault-snapshot-'))
    const msgvaultPath = join(root, 'mv.db')
    const productPath = join(root, 'product.db')
    const writer = new DatabaseSync(msgvaultPath)
    writer.exec('PRAGMA journal_mode=WAL')
    writer.exec(schema)
    writer.exec(`
      INSERT INTO sources(id,source_type,identifier) VALUES(1,'gmail','owner@example.invalid');
      INSERT INTO account_identities(source_id,address) VALUES(1,'owner@example.invalid');
      INSERT INTO conversations(id,source_id,conversation_type) VALUES(1,1,'email_thread');
      INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count)
        VALUES(1,1,1,'<old@example.invalid>','email','2030-01-01 00:00:00+00:00','old',1,0);
    `)
    const vault = openMsgvaultStore(msgvaultPath)
    const product = openProductStore(productPath, {
      now: () => 1_800_000_000_000,
      resolveReplyTarget: () => null,
      readSourceDigestKey: Buffer.alloc(32, 6),
    })
    const authority = { scope: 'snapshot-test', digestKey: Buffer.alloc(32, 6) }
    try {
      expect(listUnifiedInboxWithReconciledSnapshot(vault.db, product, authority, { limit: 1 }).items)
        .toHaveLength(1)
      expect(() => listUnifiedInboxWithReconciledSnapshot(vault.db, product, authority, { limit: 1 }, {
        afterCatalogCapture: () => writer.exec(`
          INSERT INTO account_identities(source_id,address) VALUES(1,'alias@example.invalid');
          INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count)
            VALUES(2,1,1,'<new@example.invalid>','email','2030-01-02 00:00:00+00:00','new',1,0);
        `),
      })).toThrowError(expect.objectContaining({ code: 'stale_cursor' }))
      const fresh = listUnifiedInboxWithReconciledSnapshot(vault.db, product, authority, { limit: 2 })
      expect(fresh.items.map((item) => item.messageId)).toEqual([2, 1])
      expect(product.connectedInboxSources()).toEqual([
        { sourceId: 1, identities: ['alias@example.invalid', 'owner@example.invalid'] },
      ])
    } finally {
      product.close()
      vault.db.close()
      writer.close()
    }
  })
})
