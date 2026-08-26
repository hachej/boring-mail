// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approveOutbox,
  claimApprovedOutbox,
  computeContentDigest,
  enqueueForApproval,
  getDraft,
  getOutbox,
  issueApprovalCapability,
  listOpenAttention,
  markOutboxDispatched,
  markOutboxSent,
  markOutboxUnknown,
  openProductDb,
  saveDraft,
  upsertAccount,
  type DraftInput,
  type ProductDb,
} from '../src/mail/store/productDb.js'

const baseDraft = (overrides: Partial<DraftInput> = {}): DraftInput => ({
  path: 'drafts/reply.mail.md',
  accountId: 'acct_work',
  sendAsAddress: 'work@example.com',
  replyRfc822MessageId: '<inbound@example.net>',
  replySourceId: 7,
  to: ['Client@Example.net'],
  cc: [],
  bcc: [],
  subject: 'Re: status',
  bodyMarkdown: 'Thanks — looks good.',
  attachments: [{ name: 'report.pdf', mimeType: 'application/pdf', contentHash: 'abc123', size: 42 }],
  ...overrides,
})

describe('productDb', () => {
  let product: ProductDb

  beforeEach(() => {
    const path = join(mkdtempSync(join(tmpdir(), 'boring-product-')), 'boring-mail.db')
    product = openProductDb(path)
    upsertAccount(product.db, {
      accountId: 'acct_work',
      providerSourceId: 7,
      primaryAddress: 'work@example.com',
      sendAs: ['work@example.com', 'alias@example.com'],
    })
  })

  afterEach(() => product.close())

  it('creates a revisioned draft with canonical digest and provider join keys', () => {
    const created = saveDraft(product.db, baseDraft(), 'draft-1')
    expect(created.id).toBe('draft-1')
    expect(created.revision).toBe(1)
    expect(created.to).toEqual(['client@example.net'])
    expect(created.replyRfc822MessageId).toBe('<inbound@example.net>')
    expect(created.replySourceId).toBe(7)
    expect(created.contentDigest).toBe(computeContentDigest(baseDraft()))

    // Stable object-key ordering; attachment/recipient array order remains covered.
    expect(computeContentDigest(baseDraft())).toBe(computeContentDigest({ ...baseDraft() }))
    expect(computeContentDigest(baseDraft({ to: ['a@x', 'b@x'] })))
      .not.toBe(computeContentDigest(baseDraft({ to: ['b@x', 'a@x'] })))
  })

  it('refuses disconnected/unknown accounts and unauthorised send-as identities', () => {
    expect(() => saveDraft(product.db, baseDraft({ accountId: 'missing' }))).toThrow(/disconnected or unknown/)
    expect(() => saveDraft(product.db, baseDraft({ sendAsAddress: 'attacker@example.net' }))).toThrow(/not provider-authorised/)
    upsertAccount(product.db, {
      accountId: 'acct_other', providerSourceId: 8, primaryAddress: 'other@example.com', sendAs: ['other@example.com'],
    })
    expect(() => saveDraft(product.db, baseDraft({ accountId: 'acct_other', sendAsAddress: 'other@example.com' })))
      .toThrow(/thread source/)

    upsertAccount(product.db, {
      accountId: 'acct_work', providerSourceId: 7, primaryAddress: 'work@example.com',
      sendAs: ['work@example.com'], connected: false,
    })
    expect(() => saveDraft(product.db, baseDraft())).toThrow(/disconnected or unknown/)
  })

  it('enqueues an immutable snapshot, enforces max-five backlog, and creates attention', () => {
    for (let i = 0; i < 5; i++) {
      const draft = saveDraft(product.db, baseDraft({ path: `drafts/${i}.mail.md` }), `d${i}`)
      const row = enqueueForApproval(product.db, draft.id)
      expect(row.status).toBe('pending_approval')
      expect(row.idempotencyKey).toMatch(/^<out-[0-9a-f]{32}@boring-mail\.invalid>$/)
    }
    const sixth = saveDraft(product.db, baseDraft({ path: 'drafts/6.mail.md' }), 'd6')
    expect(() => enqueueForApproval(product.db, sixth.id)).toThrow(/approval_backlog/)
    expect(listOpenAttention(product.db)).toHaveLength(5)
  })

  it('single-use capability is digest-bound and consumed atomically', () => {
    const draft = saveDraft(product.db, baseDraft(), 'draft-cap')
    const outbox = enqueueForApproval(product.db, draft.id)
    const token = issueApprovalCapability(product.db, outbox.id)

    expect(() => approveOutbox(product.db, outbox.id, 'wrong')).toThrow(/invalid/)
    expect(approveOutbox(product.db, outbox.id, token).status).toBe('approved')
    expect(getOutbox(product.db, outbox.id)?.approvalConsumedAt).not.toBeNull()
    expect(listOpenAttention(product.db)).toHaveLength(0)
    expect(() => approveOutbox(product.db, outbox.id, token)).toThrow(/not pending/)
  })

  it('content changes create a new revision and stale prior approval', () => {
    const first = saveDraft(product.db, baseDraft(), 'draft-edit')
    const queued = enqueueForApproval(product.db, first.id)
    issueApprovalCapability(product.db, queued.id)

    const edited = saveDraft(product.db, baseDraft({ bodyMarkdown: 'Changed after approval.' }))
    expect(edited.id).toBe(first.id)
    expect(edited.revision).toBe(2)
    expect(edited.contentDigest).not.toBe(first.contentDigest)
    expect(getOutbox(product.db, queued.id)?.status).toBe('stale')
  })

  it('fails closed when the outbox snapshot is tampered before approval', () => {
    const draft = saveDraft(product.db, baseDraft(), 'draft-tamper')
    const outbox = enqueueForApproval(product.db, draft.id)
    const token = issueApprovalCapability(product.db, outbox.id)
    product.db.prepare(`UPDATE mail_outbox SET bcc_json='["hidden@example.net"]' WHERE id=?`).run(outbox.id)
    expect(() => approveOutbox(product.db, outbox.id, token)).toThrow(/content digest mismatch/)
  })

  it('moves approved→sending→sent with at most one provider attempt', () => {
    const draft = saveDraft(product.db, baseDraft(), 'draft-send')
    const outbox = enqueueForApproval(product.db, draft.id)
    const token = issueApprovalCapability(product.db, outbox.id)
    approveOutbox(product.db, outbox.id, token)
    const claimed = claimApprovedOutbox(product.db, outbox.id, 'worker-1')
    expect(claimed.status).toBe('sending')
    expect(claimed.sendAttemptCount).toBe(0) // claim is not the irreversible attempt
    expect(() => markOutboxSent(product.db, outbox.id, 'gmail-too-early')).toThrow(/not a dispatched send/)
    expect(markOutboxDispatched(product.db, outbox.id, 'worker-1').sendAttemptCount).toBe(1)
    expect(() => markOutboxDispatched(product.db, outbox.id, 'worker-1')).toThrow(/already dispatched/)
    expect(() => claimApprovedOutbox(product.db, outbox.id, 'worker-2')).toThrow(/not approved or reclaimable/)
    expect(markOutboxSent(product.db, outbox.id, 'gmail-msg-1')).toMatchObject({
      status: 'sent', providerMessageId: 'gmail-msg-1', sendAttemptCount: 1,
    })
  })

  it('ambiguous send becomes unknown with a human attention item, never retries', () => {
    const draft = saveDraft(product.db, baseDraft(), 'draft-unknown')
    const outbox = enqueueForApproval(product.db, draft.id)
    approveOutbox(product.db, outbox.id, issueApprovalCapability(product.db, outbox.id))
    claimApprovedOutbox(product.db, outbox.id, 'worker-1')
    markOutboxDispatched(product.db, outbox.id, 'worker-1')
    const unknown = markOutboxUnknown(product.db, outbox.id, 'connection reset after upload')
    expect(unknown.status).toBe('unknown')
    expect(unknown.sendAttemptCount).toBe(1)
    expect(() => claimApprovedOutbox(product.db, outbox.id, 'worker-2')).toThrow(/not approved/)
    const attention = listOpenAttention(product.db)
    expect(attention).toHaveLength(1)
    expect(attention[0].kind).toBe('send_unknown')
  })

  it('reclaims an expired pre-dispatch lease without creating a second attempt', () => {
    const draft = saveDraft(product.db, baseDraft(), 'draft-reclaim')
    const outbox = enqueueForApproval(product.db, draft.id)
    approveOutbox(product.db, outbox.id, issueApprovalCapability(product.db, outbox.id))
    claimApprovedOutbox(product.db, outbox.id, 'dead-worker', -1)
    const reclaimed = claimApprovedOutbox(product.db, outbox.id, 'live-worker')
    expect(reclaimed.status).toBe('sending')
    expect(reclaimed.sendAttemptCount).toBe(0)
    expect(markOutboxDispatched(product.db, outbox.id, 'live-worker').sendAttemptCount).toBe(1)
  })

  it('requires both reply correlation keys and .mail.md paths', () => {
    expect(() => saveDraft(product.db, baseDraft({ replySourceId: undefined }))).toThrow(/supplied together/)
    expect(() => saveDraft(product.db, baseDraft({ path: 'drafts/x.txt' }))).toThrow(/\.mail\.md/)
    expect(() => saveDraft(product.db, baseDraft({ to: [] }))).toThrow(/To recipient/)
  })
})
