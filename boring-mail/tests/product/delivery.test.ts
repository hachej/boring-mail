// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openProductStore,
  type ClaimedOutbox,
  type DispatchedOutbox,
  type SentOutbox,
} from '../../src/mail/store/internalProductStore.js'
import { draft, scenario, UI_SESSION, type Scenario } from './scenario.js'
describe('durable delivery state machine', () => {
  const HISTORY = '900719925474099312345'
  let s: Scenario | undefined
  const open = () => (s = scenario())
  afterEach(() => s?.close())
  const dispatch = (x: Scenario, worker = 'w') => {
    const a = x.enqueueApproved()
    x.store.outbox.claim(a.id, worker, 100)
    x.store.outbox.markDispatched(a.id, worker, HISTORY)
    return a
  }
  it('models approved→claimed→dispatched→sent and validates result owner', () => {
    const x = open(),
      a = x.enqueueApproved(),
      claimed: ClaimedOutbox = x.store.outbox.claim(a.id, 'w', 10)
    expect(claimed).toMatchObject({
      status: 'claimed',
      lease: { owner: 'w' },
      snapshot: { messageId: a.snapshot.messageId },
    })
    const dispatched: DispatchedOutbox = x.store.outbox.markDispatched(a.id, 'w', HISTORY)
    expect(dispatched.preDispatchHistoryId).toBe(HISTORY)
    expect(() => x.store.outbox.markSent(a.id, 'other', 'gmail')).toThrow(/another worker/)
    x.clock.now += 20
    const sent: SentOutbox = x.store.outbox.markSent(a.id, 'w', 'gmail')
    expect(sent).toMatchObject({
      status: 'sent',
      delivery: { basis: 'provider', providerMessageId: 'gmail' },
    })
  })
  it('requires and durably retains the pre-dispatch Gmail history cursor', () => {
    const x = open(),
      queued = x.enqueueApproved()
    x.store.outbox.claim(queued.id, 'w', 100)
    expect(() => x.store.outbox.markDispatched(queued.id, 'w', '')).toThrow(/nonempty numeric/)
    expect(() => x.store.outbox.markDispatched(queued.id, 'w', 'not-numeric')).toThrow(/numeric/)
    expect(() => x.store.outbox.markDispatched(queued.id, 'other', HISTORY)).toThrow(/not held/)
    const dispatched = x.store.outbox.markDispatched(queued.id, 'w', HISTORY)
    expect(dispatched.preDispatchHistoryId).toBe(HISTORY)
    expect(() => x.store.outbox.markDispatched(queued.id, 'w', '2')).toThrow(/must be claimed/)
    x.store.close()
    s = undefined
    const reopened = openProductStore(x.path, {
      now: () => x.clock.now,
      resolveReplyTarget: (id) => x.targets.get(id) ?? null,
    })
    try {
      expect(reopened.outbox.get(queued.id)).toMatchObject({ status: 'dispatched', preDispatchHistoryId: HISTORY })
      x.clock.now += 101
      const [unknown] = reopened.outbox.recoverExpired()
      expect(unknown).toMatchObject({ status: 'unknown', preDispatchHistoryId: HISTORY })
      expect(reopened.outbox.dueReconciliations()[0].preDispatchHistoryId).toBe(HISTORY)
    } finally {
      reopened.close()
    }
  })
  it('serializes claims across independent handles and reclaims only expired pre-dispatch', () => {
    const x = open(),
      a = x.enqueueApproved(),
      other = openProductStore(x.path, {
        now: () => x.clock.now,
        resolveReplyTarget: (id) => x.targets.get(id) ?? null,
      })
    try {
      x.store.outbox.claim(a.id, 'a', 10)
      expect(() => other.outbox.claim(a.id, 'b')).toThrow(/expired claim/)
      x.clock.now += 10
      expect(other.outbox.claim(a.id, 'b').status).toBe('claimed')
      other.outbox.markDispatched(a.id, 'b', HISTORY)
      expect(() => x.store.outbox.claim(a.id, 'c')).toThrow(/not approved/)
    } finally {
      other.close()
    }
  })
  it('discovers approved and expired claimed work after restart without an in-memory id', () => {
    const x = open(), approved = x.enqueueApproved()
    x.store.close()
    s = undefined
    let reopened = openProductStore(x.path, {
      now: () => x.clock.now,
      resolveReplyTarget: (id) => x.targets.get(id) ?? null,
    })
    expect(reopened.outbox.claimNext('restart', 10)?.id).toBe(approved.id)
    reopened.close()
    x.clock.now += 10
    reopened = openProductStore(x.path, {
      now: () => x.clock.now,
      resolveReplyTarget: (id) => x.targets.get(id) ?? null,
    })
    const other = openProductStore(x.path, {
      now: () => x.clock.now,
      resolveReplyTarget: (id) => x.targets.get(id) ?? null,
    })
    try {
      expect(reopened.outbox.claimNext('reclaimer')?.id).toBe(approved.id)
      expect(other.outbox.claimNext('racer')).toBeNull()
    } finally {
      reopened.close()
      other.close()
    }
  })
  it('returns null when no durable send is claimable', () => {
    expect(open().store.outbox.claimNext('idle')).toBeNull()
  })
  it('claimNext skips only revoked rows so one account cannot starve another', () => {
    const x = open()
    const older = x.enqueueApproved({ path: 'drafts/older.mail.md' })
    x.clock.now++
    x.store.upsertAccount({
      accountId: 'acct_other', providerSourceId: 8,
      primaryAddress: 'other@example.com', sendAs: ['other@example.com'],
    })
    x.targets.set(202, { rfc822MessageId: '<other@example.net>', sourceId: 8 })
    const newer = x.enqueueApproved({
      path: 'drafts/newer.mail.md', replyToMessageId: 202,
      sendAsAddress: 'other@example.com',
    })
    x.store.upsertAccount({
      accountId: 'acct_work', providerSourceId: 7,
      primaryAddress: 'work@example.com', sendAs: ['work@example.com'], connected: false,
    })
    expect(x.store.outbox.claimNext('worker')?.id).toBe(newer.id)
    x.store.upsertAccount({
      accountId: 'acct_work', providerSourceId: 7,
      primaryAddress: 'work@example.com', sendAs: ['work@example.com'], connected: true,
    })
    expect(x.store.outbox.claimNext('worker')?.id).toBe(older.id)
  })

  it('claimNext fails closed on corrupt eligible work instead of skipping it', () => {
    const x = open(), older = x.enqueueApproved({ path: 'drafts/corrupt-old.mail.md' })
    x.clock.now++
    x.enqueueApproved({ path: 'drafts/valid-new.mail.md' })
    const raw = new DatabaseSync(x.path)
    raw.exec(`DROP TRIGGER mail_outbox_snapshot_immutable;
      CREATE TRIGGER mail_outbox_snapshot_immutable BEFORE UPDATE OF subject ON mail_outbox BEGIN SELECT 1; END`)
    raw.prepare(`UPDATE mail_outbox SET subject='changed without digest' WHERE id=?`).run(older.id)
    raw.close()
    expect(() => x.store.outbox.claimNext('worker')).toThrowError(
      expect.objectContaining({ code: 'content_changed' }),
    )
  })

  it('supports deterministic failure and pre-dispatch cancellation', () => {
    const x = open(),
      a = dispatch(x)
    expect(x.store.outbox.markFailed(a.id, 'w', 'invalid_recipient', '550 rejected')).toMatchObject({
      status: 'failed',
      failure: { code: 'invalid_recipient' },
    })
    const b = x.enqueueApproved({ path: 'drafts/b.mail.md' })
    expect(x.store.outbox.cancel(b.id)).toMatchObject({ status: 'cancelled', reason: 'cancelled' })
    const c = x.enqueueApproved({ path: 'drafts/c.mail.md' })
    x.store.outbox.claim(c.id, 'w')
    expect(x.store.outbox.cancel(c.id).status).toBe('cancelled')
    expect(() => x.store.outbox.markDispatched(c.id, 'w', HISTORY)).toThrow(/must be claimed/)
  })
  it('persists bounded reconciliation and asks human only at deadline', () => {
    const x = open(),
      a = dispatch(x)
    expect(x.store.outbox.markUnknown(a.id, 'w', 'timeout', 10).status).toBe('unknown')
    expect(x.store.outbox.listAttention()).toEqual([])
    expect(x.store.outbox.dueReconciliations()).toHaveLength(1)
    let row = x.store.outbox.reconciliationMiss(a.id, 10)
    expect(row.status).toBe('unknown')
    x.clock.now += 10
    row = x.store.outbox.reconciliationMiss(a.id, 10)
    expect(row.status).toBe('human_decision')
    expect(x.store.outbox.listAttention()).toHaveLength(1)
    expect(() => x.store.outbox.claim(a.id, 'retry')).toThrow(/not approved/)
  })
  it('reconciliation found records provider delivery and no human attention', () => {
    const x = open(),
      a = dispatch(x)
    x.store.outbox.markUnknown(a.id, 'w', 'reset')
    expect(x.store.outbox.reconciliationFound(a.id, 'found')).toMatchObject({
      status: 'sent',
      delivery: { basis: 'provider', providerMessageId: 'found' },
    })
    expect(x.store.outbox.listAttention()).toEqual([])
  })
  it('human decisions keep waiting, mark sent, or mint a newly approved retry candidate', () => {
    const x = open()
    const human = () => {
      const a = dispatch(x)
      x.store.outbox.markUnknown(a.id, 'w', 'timeout', 1)
      x.clock.now += 1
      x.store.outbox.reconciliationMiss(a.id, 1)
      return a
    }
    const keep = human()
    expect(x.store.outbox.keepWaiting(keep.id, 100).status).toBe('unknown')
    expect(x.store.outbox.listAttention()).toEqual([])
    const sent = human()
    expect(x.store.outbox.markHumanSent(sent.id)).toMatchObject({
      status: 'sent',
      delivery: { basis: 'human', providerMessageId: null },
    })
    const original = human(),
      oldMessage = original.snapshot.messageId,
      retry = x.store.outbox.retry(original.id, 'human-retry')
    expect(x.store.outbox.get(original.id)).toMatchObject({ status: 'cancelled', reason: 'retry' })
    expect(retry).toMatchObject({ status: 'pending_approval', retryOf: original.id, operationKey: 'human-retry' })
    expect(retry.snapshot.messageId).not.toBe(oldMessage)
    expect(x.store.outbox.retry(original.id, 'human-retry')).toEqual(retry)
    expect(() => x.store.outbox.retry(original.id, 'different-retry-key')).toThrowError(
      expect.objectContaining({ code: 'idempotency_conflict' }),
    )
    expect(x.store.outbox.listAttention()).toHaveLength(1)
    expect(() => x.store.outbox.claim(retry.id, 'w')).toThrow(/not approved/)
  })
  it('reaper race is serialized and starts reconciliation without attention', () => {
    const x = open(),
      a = dispatch(x)
    x.clock.now += 101
    expect(x.store.outbox.recoverExpired()).toHaveLength(1)
    expect(x.store.outbox.get(a.id)?.status).toBe('unknown')
    expect(x.store.outbox.recoverExpired()).toEqual([])
    expect(x.store.outbox.listAttention()).toEqual([])
    expect(() => x.store.outbox.markSent(a.id, 'w', 'late')).toThrow(/must be dispatched/)
  })
  it('rejects predecessor and terminal-state transitions across the matrix', () => {
    const x = open(),
      pending = x.store.outbox.enqueue(x.save().id, 'cancel-pending')
    expect(() => x.store.outbox.claim(pending.id, 'w')).toThrow(/not approved/)
    expect(() => x.store.outbox.markDispatched(pending.id, 'w', HISTORY)).toThrow(/must be claimed/)

    const terminalIds: string[] = [x.store.outbox.reject(pending.id).id]
    const sent = dispatch(x)
    terminalIds.push(x.store.outbox.markSent(sent.id, 'w', 'gmail').id)
    const failed = dispatch(x)
    terminalIds.push(x.store.outbox.markFailed(failed.id, 'w', '550', 'rejected').id)
    const rejected = x.store.outbox.enqueue(x.save({ path: 'drafts/rejected.mail.md' }).id, 'reject-row')
    terminalIds.push(x.store.outbox.reject(rejected.id).id)
    const cancelled = x.enqueueApproved({ path: 'drafts/cancelled.mail.md' })
    terminalIds.push(x.store.outbox.cancel(cancelled.id).id)
    const stale = x.store.outbox.enqueue(x.save({ path: 'drafts/stale.mail.md' }).id, 'stale-row')
    x.save({ path: 'drafts/stale.mail.md', bodyMarkdown: 'edited' })
    terminalIds.push(stale.id)

    for (const id of terminalIds) {
      expect(() => x.store.outbox.claim(id, 'w')).toThrow()
      expect(() => x.store.outbox.markDispatched(id, 'w', HISTORY)).toThrow()
      expect(() => x.store.outbox.markSent(id, 'w', 'gmail')).toThrow()
      expect(() => x.store.outbox.markUnknown(id, 'w', 'timeout')).toThrow()
      expect(() => x.store.outbox.reconciliationFound(id, 'gmail')).toThrow()
      expect(() => x.store.outbox.retry(id, `illegal-${id}`)).toThrow()
    }
    expect(x.store.outbox.listAttention()).toEqual([])
  })
})
