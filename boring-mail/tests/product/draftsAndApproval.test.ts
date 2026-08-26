// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { draftContentDigest, ProductStoreError } from '../../src/mail/store/productDb.js'
import { draft, scenario, type Scenario } from './scenario.js'

describe('ProductStore drafts and approval', () => {
  let current: Scenario | undefined
  const open = () => (current = scenario())
  afterEach(() => current?.close())

  it('normalizes a safe registry path and keeps it outside the wire digest', () => {
    const { store } = open()
    const saved = store.saveDraft(draft({ path: './drafts/reply.mail.md' }), 'draft-1')
    expect(saved).toMatchObject({
      id: 'draft-1', path: 'drafts/reply.mail.md', revision: 1,
      to: ['client@example.net'], reply: { rfc822MessageId: '<inbound@example.net>', sourceId: 7 },
    })
    expect(draftContentDigest({ ...saved, path: 'drafts/renamed.mail.md' }))
      .toBe(draftContentDigest(saved))
    expect(draftContentDigest({ ...saved, to: ['a@x', 'b@x'] }))
      .not.toBe(draftContentDigest({ ...saved, to: ['b@x', 'a@x'] }))
  })

  it('makes an identical save idempotent in pending and approved states', () => {
    const { store, save } = open()
    const saved = save({}, 'same')
    const pending = store.enqueue(saved.id)
    expect(save()).toMatchObject({ id: saved.id, revision: 1 })
    expect(store.getOutbox(pending.id)?.status).toBe('pending_approval')

    const token = store.issueApprovalCapability(pending.id)
    store.approve(pending.id, token)
    expect(save()).toMatchObject({ id: saved.id, revision: 1 })
    expect(store.getOutbox(pending.id)?.status).toBe('approved')
  })

  it('edits create revisions and stale pending, approved and claimed snapshots atomically', () => {
    const { store, save } = open()
    const first = save({}, 'draft-edit')
    const pending = store.enqueue(first.id)
    const approved = store.enqueue(first.id)
    store.approve(approved.id, store.issueApprovalCapability(approved.id))
    const claimed = store.enqueue(first.id)
    store.approve(claimed.id, store.issueApprovalCapability(claimed.id))
    store.claim(claimed.id, 'worker')

    const edited = save({ bodyMarkdown: 'Changed.' })
    expect(edited).toMatchObject({ id: first.id, revision: 2 })
    for (const id of [pending.id, approved.id, claimed.id]) {
      expect(store.getOutbox(id)?.status).toBe('stale')
    }
    expect(store.listAttention()).toEqual([])
  })

  it('binds replies to trusted msgvault ownership, including paired source spoof attempts', () => {
    const { store } = open()
    store.upsertAccount({
      accountId: 'other', providerSourceId: 8, primaryAddress: 'other@example.com', sendAs: ['other@example.com'],
    })
    expect(() => store.saveDraft(draft({ accountId: 'other', sendAsAddress: 'other@example.com' })))
      .toThrowError(ProductStoreError)
    expect(() => store.saveDraft(draft({
      accountId: 'other', sendAsAddress: 'other@example.com',
      reply: { rfc822MessageId: '<inbound@example.net>', sourceId: 8 },
    }))).toThrow(/trusted msgvault/)
  })

  it('revalidates account and send-as identity at approval', () => {
    const { store, save } = open()
    const queued = store.enqueue(save().id)
    const token = store.issueApprovalCapability(queued.id)
    store.upsertAccount({
      accountId: 'acct_work', providerSourceId: 7, primaryAddress: 'work@example.com',
      sendAs: ['work@example.com'], connected: false,
    })
    expect(() => store.approve(queued.id, token)).toThrow(/disconnected/)
  })

  it('enforces five pending approvals per account', () => {
    const { store, save } = open()
    for (let index = 0; index < 5; index++) {
      store.enqueue(save({ path: `drafts/${index}.mail.md` }, `d${index}`).id)
    }
    const sixth = save({ path: 'drafts/sixth.mail.md' }, 'sixth')
    expect(() => store.enqueue(sixth.id)).toThrow(/maximum 5/)
    expect(store.listAttention()).toHaveLength(5)
  })

  it('uses a short-lived single-use digest-bound capability', () => {
    const { store, save, clock } = open()
    const queued = store.enqueue(save().id)
    const expired = store.issueApprovalCapability(queued.id, 10)
    clock.now += 10
    expect(() => store.approve(queued.id, expired)).toThrow(/expired/)

    const fresh = store.issueApprovalCapability(queued.id, 100)
    expect(() => store.approve(queued.id, 'wrong')).toThrow(/invalid/)
    expect(store.approve(queued.id, fresh).status).toBe('approved')
    expect(() => store.approve(queued.id, fresh)).toThrow(/must be pending_approval/)
    expect(store.listAttention()).toEqual([])
  })

  it('rejects invalid time inputs and the schema rejects malformed stored deadlines', () => {
    const { store, save, path } = open()
    const queued = store.enqueue(save().id)
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.issueApprovalCapability(queued.id, ttl)).toThrow(/positive finite/)
    }
    store.issueApprovalCapability(queued.id, 100)
    const raw = new DatabaseSync(path)
    expect(() => raw.prepare(`UPDATE mail_outbox SET approval_expires_ms='bad' WHERE id=?`).run(queued.id))
      .toThrow()
    expect(() => raw.prepare(`UPDATE mail_outbox SET approval_expires_ms=NULL WHERE id=?`).run(queued.id))
      .toThrow()
    raw.close()
  })

  it('makes the digest-bound send snapshot immutable in SQLite', () => {
    const { store, save, path } = open()
    const queued = store.enqueue(save().id)
    const token = store.issueApprovalCapability(queued.id)
    const raw = new DatabaseSync(path)
    expect(() => raw.prepare(`UPDATE mail_outbox SET bcc_json='["hidden@example.net"]' WHERE id=?`).run(queued.id))
      .toThrow(/snapshot is immutable/)
    raw.close()
    expect(store.approve(queued.id, token).status).toBe('approved')
  })

  it('rejects pending sends and resolves approval attention atomically', () => {
    const { store, save } = open()
    const queued = store.enqueue(save().id)
    const attention = store.listAttention()[0]
    expect(store.reject(queued.id).status).toBe('rejected')
    expect(store.listAttention()).toEqual([])
    expect(store.listAttention(false).find((item) => item.id === attention.id)?.resolvedAt).not.toBeNull()
  })

  it('validates draft paths, recipients and attachment metadata', () => {
    const { store } = open()
    expect(() => store.saveDraft(draft({ path: '../escape.mail.md' }))).toThrow(/may not escape/)
    expect(() => store.saveDraft(draft({ path: 'draft.txt' }))).toThrow(/\.mail\.md/)
    expect(() => store.saveDraft(draft({ to: [] }))).toThrow(/To recipient/)
    expect(() => store.saveDraft(draft({ attachments: [
      { name: 'bad', mimeType: 'x/x', contentHash: 'hash', size: Number.NaN },
    ] }))).toThrow(/safe integer/)
  })
})
