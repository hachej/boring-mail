// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  draftContentDigest,
  openProductStore,
  ProductStoreError,
  sendSnapshotDigest,
  type ReplyDraftInput,
} from '../../src/mail/store/productDb.js'
import { draft, reply, scenario, UI_SESSION, type Scenario } from './scenario.js'
describe('ProductStore drafts and approvals', () => {
  let s: Scenario | undefined
  const open = () => (s = scenario())
  afterEach(() => s?.close())
  it('derives reply account and keys from immutable msgvault message row', () => {
    const { store, targets } = open()
    store.upsertAccount({
      accountId: 'other',
      providerSourceId: 8,
      primaryAddress: 'other@x',
      sendAs: ['other@x'],
    })
    targets.set(202, { rfc822MessageId: reply.rfc822MessageId, sourceId: 8 })
    const work = store.saveDraft(draft(), 'work')
    const other = store.saveDraft(
      draft({ path: 'drafts/other.mail.md', replyToMessageId: 202, sendAsAddress: 'other@x' }),
      'other',
    )
    expect(work).toMatchObject({ accountId: 'acct_work', reply: { messageId: 101, sourceId: 7 } })
    expect(other).toMatchObject({ accountId: 'other', reply: { messageId: 202, sourceId: 8 } })
    expect(draft({ replyToMessageId: 101 })).not.toHaveProperty('accountId')
  })
  it('uses one explicit content projection and ignores record metadata', () => {
    const { store } = open(),
      saved = store.saveDraft(draft(), 'id')
    expect(draftContentDigest(saved)).toBe(saved.contentDigest)
    expect(
      draftContentDigest({
        ...saved,
        id: 'other',
        revision: 99,
        path: 'other.mail.md',
        contentDigest: 'bad',
      }),
    ).toBe(saved.contentDigest)
    expect(draftContentDigest({ ...saved, bcc: ['hidden@x'] })).not.toBe(saved.contentDigest)
  })
  it('idempotent saves preserve approvals; edits stale pending approved and claimed', () => {
    const { store, save } = open(),
      saved = save({}, 'd')
    const ids = [
      store.outbox.enqueue(saved.id),
      store.outbox.enqueue(saved.id),
      store.outbox.enqueue(saved.id),
    ]
    store.outbox.approve(ids[1].id, store.outbox.issueApprovalCapability(ids[1].id, UI_SESSION), UI_SESSION)
    store.outbox.approve(ids[2].id, store.outbox.issueApprovalCapability(ids[2].id, UI_SESSION), UI_SESSION)
    store.outbox.claim(ids[2].id, 'w')
    expect(save()).toMatchObject({ revision: 1 })
    save({ bodyMarkdown: 'changed' })
    expect(ids.map((x) => store.outbox.get(x.id)?.status)).toEqual(['stale', 'stale', 'stale'])
    expect(store.outbox.listAttention()).toEqual([])
  })
  it('binds capability to authenticated session and consumes it once', () => {
    const { store, save, clock, path } = open(),
      q = store.outbox.enqueue(save().id)
    expect(() => store.outbox.issueApprovalCapability(q.id, '')).toThrow(/session/)
    const first = store.outbox.issueApprovalCapability(q.id, 'session-a', 10)
    const raw = new DatabaseSync(path)
    const stored = raw
      .prepare(`SELECT approval_cap_hash,approval_session_hash FROM mail_outbox WHERE id=?`)
      .get(q.id) as { approval_cap_hash: string; approval_session_hash: string }
    raw.close()
    expect(stored.approval_cap_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.approval_session_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.values(stored)).not.toContain(first)
    expect(Object.values(stored)).not.toContain('session-a')
    expect(() => store.outbox.approve(q.id, first, 'session-b')).toThrow(/session binding/)
    const replacement = store.outbox.issueApprovalCapability(q.id, 'session-a', 100)
    expect(() => store.outbox.approve(q.id, first, 'session-a')).toThrow(/invalid/)
    clock.now += 100
    expect(() => store.outbox.approve(q.id, replacement, 'session-a')).toThrow(/expired/)
    const fresh = store.outbox.issueApprovalCapability(q.id, 'session-a', 100)
    expect(store.outbox.approve(q.id, fresh, 'session-a').status).toBe('approved')
    expect(() => store.outbox.approve(q.id, fresh, 'session-a')).toThrow(/must be pending/)
  })
  it('binds approval verifier to token, session, outbox and issued digest', () => {
    const { store, save, path } = open(),
      queued = store.outbox.enqueue(save().id),
      token = store.outbox.issueApprovalCapability(queued.id, UI_SESSION),
      altered = { ...queued.snapshot, subject: 'bait-and-switch' },
      alteredDigest = draftContentDigest(altered) // snapshot digest differs by Message-ID coverage below
    const raw = new DatabaseSync(path)
    raw.exec(`DROP TRIGGER mail_outbox_snapshot_immutable;
      CREATE TRIGGER mail_outbox_snapshot_immutable BEFORE UPDATE OF subject ON mail_outbox BEGIN SELECT 1; END`)
    // Use the exact altered snapshot digest; this defeats a plain digest-equality check.
    raw.prepare(`UPDATE mail_outbox SET subject=?,content_digest=? WHERE id=?`)
      .run(altered.subject, sendSnapshotDigest(altered), queued.id)
    raw.close()
    expect(alteredDigest).not.toBe(queued.contentDigest)
    expect(() => store.outbox.approve(queued.id, token, UI_SESSION)).toThrow(/capability or session binding invalid/)
    store.close()
    s = undefined
    expect(() => openProductStore(path, { now: () => 1, resolveReplyTarget: () => null }))
      .toThrow(/definition mismatch: trigger:mail_outbox_snapshot_immutable/)
  })
  it('binds approval verifier to the issued expiry', () => {
    const { store, save, path } = open(),
      queued = store.outbox.enqueue(save({ path: 'drafts/expiry-binding.mail.md' }, 'expiry-binding').id),
      token = store.outbox.issueApprovalCapability(queued.id, UI_SESSION, 100)
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE mail_outbox SET approval_expires_ms=approval_expires_ms+10000 WHERE id=?`)
      .run(queued.id)
    raw.close()
    expect(() => store.outbox.approve(queued.id, token, UI_SESSION)).toThrow(/capability or session binding invalid/)
  })
  it('revalidates trusted row and identity at approval', () => {
    const { store, save, targets } = open(),
      q = store.outbox.enqueue(save().id),
      token = store.outbox.issueApprovalCapability(q.id, UI_SESSION)
    targets.delete(reply.messageId)
    expect(() => store.outbox.approve(q.id, token, UI_SESSION)).toThrow(/trusted msgvault/)
  })
  it('serializes max-five backlog across two store handles', () => {
    const a = open(),
      deps = { now: () => a.clock.now, resolveReplyTarget: (id: number) => a.targets.get(id) ?? null },
      other = openProductStore(a.path, deps)
    try {
      for (let i = 0; i < 5; i++)
        a.store.outbox.enqueue(a.store.saveDraft(draft({ path: `drafts/${i}.mail.md` }), `d${i}`).id)
      const sixth = a.store.saveDraft(draft({ path: 'drafts/6.mail.md' }), 'd6')
      expect(() => other.outbox.enqueue(sixth.id)).toThrow(/maximum 5/)
    } finally {
      other.close()
    }
  })
  it('rejects approval and only lifecycle transitions resolve attention', () => {
    const { store, save } = open(),
      q = store.outbox.enqueue(save().id),
      item = store.outbox.listAttention()[0]
    expect(store.outbox).not.toHaveProperty('resolveAttention')
    expect(store.outbox.reject(q.id).status).toBe('rejected')
    expect(store.outbox.listAttention()).toEqual([])
    expect(store.outbox.listAttention(false).find((x) => x.id === item.id)?.resolvedAt).not.toBeNull()
  })
  it('fails typed on durable malformed JSON after reopen', () => {
    const current = open(),
      saved = current.save({}, 'corrupt'),
      path = current.path,
      targets = current.targets,
      clock = current.clock
    current.store.close()
    s = undefined
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE mail_drafts SET to_json='["ok@example.com",1]' WHERE id=?`).run(saved.id)
    raw.close()
    const reopened = openProductStore(path, {
      now: () => clock.now,
      resolveReplyTarget: (id) => targets.get(id) ?? null,
    })
    try {
      expect(() => reopened.getDraft(saved.id)).toThrowError(
        expect.objectContaining({ code: 'corrupt_data' }),
      )
    } finally {
      reopened.close()
    }
  })
  it('rejects valid-JSON durable rows with invalid mail semantics', () => {
    const { store, save, path } = open(),
      saved = save({}, 'semantic')
    const raw = new DatabaseSync(path)
    const cases: Array<[string, string, string]> = [
      ['to_json', '[]', JSON.stringify(saved.to)],
      ['to_json', '[""]', JSON.stringify(saved.to)],
      ['attachments_json', '[{"name":"x","mimeType":"text/plain","contentHash":"","size":1}]', JSON.stringify(saved.attachments)],
      ['send_as_address', ' Work@Example.com ', saved.sendAsAddress],
      ['subject', 'changed without its digest', saved.subject],
      ['path', './drafts/reply.mail.md', saved.path],
      ['content_digest', 'bad', saved.contentDigest],
    ]
    for (const [column, invalid, valid] of cases) {
      raw.prepare(`UPDATE mail_drafts SET ${column}=? WHERE id=?`).run(invalid, saved.id)
      expect(() => store.getDraft(saved.id)).toThrowError(expect.objectContaining({ code: 'corrupt_data' }))
      expect(() => store.outbox.enqueue(saved.id)).toThrowError(expect.objectContaining({ code: 'corrupt_data' }))
      raw.prepare(`UPDATE mail_drafts SET ${column}=? WHERE id=?`).run(valid, saved.id)
    }
    const queued = store.outbox.enqueue(saved.id)
    raw.exec(`DROP TRIGGER mail_outbox_snapshot_immutable;
      CREATE TRIGGER mail_outbox_snapshot_immutable BEFORE UPDATE OF subject ON mail_outbox BEGIN SELECT 1; END`)
    raw.prepare(`UPDATE mail_outbox SET message_id='bad-message-id' WHERE id=?`).run(queued.id)
    expect(() => store.outbox.get(queued.id)).toThrowError(expect.objectContaining({ code: 'corrupt_data' }))
    raw.prepare(`UPDATE mail_outbox SET message_id=?,content_digest='BAD' WHERE id=?`)
      .run(queued.snapshot.messageId, queued.id)
    expect(() => store.outbox.get(queued.id)).toThrowError(expect.objectContaining({ code: 'corrupt_data' }))
    raw.close()
  })
  it('validates inputs, JSON constraints, and malformed durable capability state', () => {
    const { store, save, path } = open()
    expect(() => store.saveDraft(draft({ path: '../x.mail.md' }))).toThrow(/escape/)
    expect(() => store.saveDraft(draft({ replyToMessageId: Number.NaN }))).toThrow(/safe integer/)
    const q = store.outbox.enqueue(save().id)
    store.outbox.issueApprovalCapability(q.id, UI_SESSION)
    const raw = new DatabaseSync(path)
    expect(() => raw.prepare(`UPDATE mail_outbox SET to_json='{}' WHERE id=?`).run(q.id)).toThrow()
    raw.prepare(`UPDATE mail_outbox SET approval_session_hash='not-a-hash' WHERE id=?`).run(q.id)
    raw.close()
    expect(() => store.outbox.get(q.id)).toThrowError(expect.objectContaining({ code: 'corrupt_data' }))
  })
})
