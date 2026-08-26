// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  openProductStore,
  type ClaimedOutbox,
  type DispatchedOutbox,
  type SentOutbox,
} from '../../src/mail/store/productDb.js'
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
      retry = x.store.outbox.retry(original.id)
    expect(x.store.outbox.get(original.id)).toMatchObject({ status: 'cancelled', reason: 'retry' })
    expect(retry).toMatchObject({ status: 'pending_approval', retryOf: original.id })
    expect(retry.snapshot.messageId).not.toBe(oldMessage)
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
      pending = x.store.outbox.enqueue(x.save().id)
    expect(() => x.store.outbox.claim(pending.id, 'w')).toThrow(/not approved/)
    expect(() => x.store.outbox.markDispatched(pending.id, 'w', HISTORY)).toThrow(/must be claimed/)

    const terminalIds: string[] = [x.store.outbox.reject(pending.id).id]
    const sent = dispatch(x)
    terminalIds.push(x.store.outbox.markSent(sent.id, 'w', 'gmail').id)
    const failed = dispatch(x)
    terminalIds.push(x.store.outbox.markFailed(failed.id, 'w', '550', 'rejected').id)
    const rejected = x.store.outbox.enqueue(x.save({ path: 'drafts/rejected.mail.md' }).id)
    terminalIds.push(x.store.outbox.reject(rejected.id).id)
    const cancelled = x.enqueueApproved({ path: 'drafts/cancelled.mail.md' })
    terminalIds.push(x.store.outbox.cancel(cancelled.id).id)
    const stale = x.store.outbox.enqueue(x.save({ path: 'drafts/stale.mail.md' }).id)
    x.save({ path: 'drafts/stale.mail.md', bodyMarkdown: 'edited' })
    terminalIds.push(stale.id)

    for (const id of terminalIds) {
      expect(() => x.store.outbox.claim(id, 'w')).toThrow()
      expect(() => x.store.outbox.markDispatched(id, 'w', HISTORY)).toThrow()
      expect(() => x.store.outbox.markSent(id, 'w', 'gmail')).toThrow()
      expect(() => x.store.outbox.markUnknown(id, 'w', 'timeout')).toThrow()
      expect(() => x.store.outbox.reconciliationFound(id, 'gmail')).toThrow()
      expect(() => x.store.outbox.retry(id)).toThrow()
    }
    expect(x.store.outbox.listAttention()).toEqual([])
  })
})
