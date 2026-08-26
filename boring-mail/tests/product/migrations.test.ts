// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openProductStore, PRODUCT_SCHEMA_VERSION } from '../../src/mail/store/productDb.js'
import { migrateProductDatabase } from '../../src/mail/store/product/migrations.js'
const deps = { now: () => 1_800_000_000_000, resolveReplyTarget: () => null }
const temp = () => join(mkdtempSync(join(tmpdir(), 'product-migration-')), 'db.sqlite')
const version = (db: DatabaseSync) =>
  Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
describe('product migrations', () => {
  it('atomically bootstraps v0, enables foreign keys and reopens state', () => {
    const path = temp(),
      first = openProductStore(path, deps)
    first.upsertAccount({ accountId: 'a', providerSourceId: 1, primaryAddress: 'a@x', sendAs: ['a@x'] })
    first.saveDraft(
      {
        kind: 'compose',
        path: 'a.mail.md',
        accountId: 'a',
        sendAsAddress: 'a@x',
        to: ['b@x'],
        subject: 's',
        bodyMarkdown: 'b',
      },
      'd',
    )
    first.close()
    const second = openProductStore(path, deps)
    expect(second.getDraft('d')?.subject).toBe('s')
    second.close()
    const db = new DatabaseSync(path)
    expect(version(db)).toBe(PRODUCT_SCHEMA_VERSION)
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name='mail_outbox_snapshot_immutable'`)
          .get() as { n: number }
      ).n,
    ).toBe(1)
    db.close()
  })
  it('rejects future and version-only fake current schemas', () => {
    for (const fake of ['future', 'fake']) {
      const path = temp(),
        db = new DatabaseSync(path)
      db.exec(
        `PRAGMA user_version=${fake === 'future' ? PRODUCT_SCHEMA_VERSION + 1 : PRODUCT_SCHEMA_VERSION}`,
      )
      db.close()
      expect(() => openProductStore(path, deps)).toThrow(fake === 'future' ? /newer/ : /missing table/)
    }
  })
  it('validates every current column, index, and trigger on open', () => {
    const triggerPath = temp()
    openProductStore(triggerPath, deps).close()
    const triggerDb = new DatabaseSync(triggerPath)
    triggerDb.exec(`DROP TRIGGER mail_outbox_snapshot_immutable`)
    triggerDb.close()
    expect(() => openProductStore(triggerPath, deps)).toThrow(/missing trigger/)

    const columnPath = temp()
    openProductStore(columnPath, deps).close()
    const columnDb = new DatabaseSync(columnPath)
    columnDb.exec(`ALTER TABLE mail_attention RENAME COLUMN detail TO broken_detail`)
    columnDb.close()
    expect(() => openProductStore(columnPath, deps)).toThrow(/mail_attention missing columns: detail/)
  })
  it('rejects current schemas with foreign-key corruption', () => {
    const path = temp()
    openProductStore(path, deps).close()
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA foreign_keys=OFF`)
    db.prepare(
      `INSERT INTO mail_drafts(
      id,path,revision,account_id,send_as_address,to_json,cc_json,bcc_json,subject,
      body_markdown,attachments_json,content_digest,created_ms,updated_ms
    ) VALUES('bad','bad.mail.md',1,'missing','x@x','["y@y"]','[]','[]','s','b','[]','hash',1,1)`,
    ).run()
    db.close()
    expect(() => openProductStore(path, deps)).toThrow(/foreign-key violations/)
  })

  it('rolls back failed unversioned migration', () => {
    const path = temp(),
      db = new DatabaseSync(path)
    db.exec(`CREATE TABLE mail_legacy(id TEXT)`)
    expect(() => migrateProductDatabase(db)).toThrow(/unversioned/)
    expect(version(db)).toBe(0)
    db.close()
  })
  it('two handles observe one serialized current schema', () => {
    const path = temp(),
      a = openProductStore(path, deps),
      b = openProductStore(path, deps)
    try {
      a.upsertAccount({ accountId: 'a', providerSourceId: 1, primaryAddress: 'a@x', sendAs: ['a@x'] })
      expect(() =>
        b.upsertAccount({ accountId: 'b', providerSourceId: 1, primaryAddress: 'b@x', sendAs: ['b@x'] }),
      ).toThrow()
    } finally {
      a.close()
      b.close()
    }
  })
})
