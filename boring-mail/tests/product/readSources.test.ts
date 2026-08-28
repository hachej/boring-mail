// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openProductStore } from '../../src/mail/store/internalProductStore.js'
import { eligibleSourceGeneration } from '../../src/mail/store/msgvaultAdapter.js'

const deps = { now: () => 1_800_000_000_000, resolveReplyTarget: () => null, readSourceDigestKey: Buffer.alloc(32, 9) }
const path = () => join(mkdtempSync(join(tmpdir(), 'read-sources-')), 'product.db')

describe('product read-source catalog', () => {
  it('reconciles add/remove/disable without mutating send authorization', () => {
    const store = openProductStore(path(), deps)
    try {
      const firstReconcile = store.reconcileMsgvaultReadSources([
        { sourceId: 1, exactIdentifier: 'Owner@Example.invalid', identities: ['alias@example.invalid'] },
        { sourceId: 2, exactIdentifier: 'second@example.invalid', identities: [] },
      ])
      expect(firstReconcile).toMatchObject({ inserted: 2, updated: 0, vanished: 0 })
      expect(firstReconcile.generation).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(firstReconcile.generation).not.toContain('Owner')
      expect(firstReconcile.generation).not.toContain('alias')
      expect(firstReconcile.generation).toBe(eligibleSourceGeneration(store.connectedInboxSources(), { digestKey: deps.readSourceDigestKey }))
      expect(store.connectedInboxSources()).toEqual([
        { sourceId: 1, identities: ['alias@example.invalid', 'owner@example.invalid'] },
        { sourceId: 2, identities: ['second@example.invalid'] },
      ])
      store.setReadSourceEnabled(1, false)
      expect(store.connectedInboxSources()).toEqual([{ sourceId: 2, identities: ['second@example.invalid'] }])
      const secondReconcile = store.reconcileMsgvaultReadSources([
        { sourceId: 1, exactIdentifier: 'Owner@Example.invalid', identities: ['new@example.invalid'] },
        { sourceId: 3, exactIdentifier: 'third@example.invalid', identities: [] },
      ])
      expect(secondReconcile).toMatchObject({ inserted: 1, updated: 1, vanished: 1 })
      expect(secondReconcile.generation).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(secondReconcile.generation).not.toBe(firstReconcile.generation)
      expect(store.connectedInboxSources()).toEqual([{ sourceId: 3, identities: ['third@example.invalid'] }])
      expect(() => store.saveDraft({
        kind: 'compose', path: 'x.mail.md', accountId: 'source-3', sendAsAddress: 'third@example.invalid', to: ['a@example.invalid'], subject: 's', bodyMarkdown: 'b',
      })).toThrow(/disconnected or unknown/)
    } finally {
      store.close()
    }
  })

  it('fails closed on source and identity collisions or corrupt catalog JSON', () => {
    const dbPath = path()
    const store = openProductStore(dbPath, deps)
    try {
      expect(() => store.reconcileMsgvaultReadSources([
        { sourceId: 1, exactIdentifier: 'a@example.invalid', identities: [] },
        { sourceId: 1, exactIdentifier: 'b@example.invalid', identities: [] },
      ])).toThrow(/unique positive/)
      expect(() => store.reconcileMsgvaultReadSources([
        { sourceId: 1, exactIdentifier: 'a@example.invalid', identities: ['shared@example.invalid'] },
        { sourceId: 2, exactIdentifier: 'b@example.invalid', identities: ['shared@example.invalid'] },
      ])).toThrow(/collision/)
      expect(() => store.reconcileMsgvaultReadSources([
        { sourceId: 1, exactIdentifier: 'not-an-email', identities: [] },
      ])).toThrow(/identifier is invalid/)
      store.reconcileMsgvaultReadSources([{ sourceId: 1, exactIdentifier: 'a@example.invalid', identities: [] }])
      const writer = new DatabaseSync(dbPath)
      writer.prepare(`UPDATE mail_read_sources SET identities_json='[1]' WHERE source_id=1`).run()
      writer.close()
      expect(() => store.connectedInboxSources()).toThrow(/must contain text/)
    } finally {
      store.close()
    }
  })
})
