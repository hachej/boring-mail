// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openProductStore, PRODUCT_SCHEMA_VERSION } from '../../src/mail/store/productDb.js'
import { migrateProductDatabase } from '../../src/mail/store/product/migrations.js'

const deps = {
  now: () => 1_800_000_000_000,
  verifyReplyOwnership: () => true,
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'product-migration-')), 'product.db')
}

function version(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

describe('product database migrations', () => {
  it('atomically migrates a fresh v0 database to the ordered current schema', () => {
    const path = tempPath()
    const store = openProductStore(path, deps)
    store.close()
    const db = new DatabaseSync(path)
    expect(version(db)).toBe(PRODUCT_SCHEMA_VERSION)
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mail_%' ORDER BY name`)
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(['mail_accounts', 'mail_attention', 'mail_drafts', 'mail_outbox'])
    db.close()
  })

  it('reopens v1 without replaying migrations or losing product state', () => {
    const path = tempPath()
    const first = openProductStore(path, deps)
    first.upsertAccount({
      accountId: 'a', providerSourceId: 1, primaryAddress: 'a@example.com', sendAs: ['a@example.com'],
    })
    first.saveDraft({
      path: 'drafts/a.mail.md', accountId: 'a', sendAsAddress: 'a@example.com',
      to: ['b@example.com'], subject: 'hello', bodyMarkdown: 'body',
    }, 'durable')
    first.close()
    const reopened = openProductStore(path, deps)
    expect(reopened.getDraft('durable')).toMatchObject({ id: 'durable', revision: 1, subject: 'hello' })
    reopened.close()
  })

  it('fails closed on a future schema version', () => {
    const path = tempPath()
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION + 1}`)
    db.close()
    expect(() => openProductStore(path, deps)).toThrow(/newer than supported/)
  })

  it('rolls back and preserves v0 when an unversioned product schema cannot migrate', () => {
    const path = tempPath()
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE mail_legacy (id TEXT PRIMARY KEY) STRICT`)
    expect(() => migrateProductDatabase(db)).toThrow(/unversioned product tables/)
    expect(version(db)).toBe(0)
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mail_%'`).all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(['mail_legacy'])
    db.close()
  })
})
