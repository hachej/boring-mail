// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openMsgvaultStore } from '../src/mail/store/msgvaultAdapter.js'
import { readMsgvaultGmailReadSourceSnapshot } from '../src/mail/store/msgvault/readSources.js'

const schema = readFileSync(new URL('./fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8')
function fixture(): { raw: DatabaseSync; db: DatabaseSync } {
  const path = join(mkdtempSync(join(tmpdir(), 'msgvault-read-sources-')), 'mv.db')
  const raw = new DatabaseSync(path)
  raw.exec(schema)
  const store = openMsgvaultStore(path)
  return { raw, db: store.db }
}

describe('msgvault Gmail read-source snapshot', () => {
  it('reads exact Gmail sources plus confirmed account identities in one snapshot', () => {
    const { raw, db } = fixture()
    try {
      raw.exec(`
        INSERT INTO sources(id,source_type,identifier) VALUES
          (1,'gmail','Owner@Example.invalid'),(2,'imap','imap@example.invalid'),(3,'gmail','other@example.invalid');
        INSERT INTO account_identities(source_id,address,source_signal) VALUES
          (1,'alias@example.invalid','gmail-send-as'),(1,'OWNER@example.invalid','primary'),(3,'third@example.invalid','');
      `)
      expect(readMsgvaultGmailReadSourceSnapshot(db)).toEqual([
        { sourceId: 1, exactIdentifier: 'Owner@Example.invalid', identities: ['alias@example.invalid', 'owner@example.invalid'] },
        { sourceId: 3, exactIdentifier: 'other@example.invalid', identities: ['other@example.invalid', 'third@example.invalid'] },
      ])
    } finally {
      db.close(); raw.close()
    }
  })

  it('rejects alias collisions and exact v0.19.3 schema drift', () => {
    const { raw, db } = fixture()
    try {
      raw.exec(`
        INSERT INTO sources(id,source_type,identifier) VALUES
          (1,'gmail','a@example.invalid'),(2,'gmail','b@example.invalid');
        INSERT INTO account_identities(source_id,address) VALUES
          (1,'shared@example.invalid'),(2,'SHARED@example.invalid');
      `)
      expect(() => readMsgvaultGmailReadSourceSnapshot(db)).toThrow(/collision/)
    } finally {
      db.close(); raw.close()
    }

    const driftPath = join(mkdtempSync(join(tmpdir(), 'msgvault-read-drift-')), 'mv.db')
    const drift = new DatabaseSync(driftPath)
    drift.exec(schema.replace('CREATE TABLE account_identities (', 'CREATE TABLE account_identities_broken ('))
    expect(() => openMsgvaultStore(driftPath)).toThrow(/account_identities/)
    drift.close()
  })
})
