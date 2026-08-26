// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { scenario, type Scenario } from './scenario.js'

describe('ProductStore delivery state machine', () => {
  let current: Scenario | undefined
  const open = () => (current = scenario())
  afterEach(() => current?.close())

  it('returns the immutable approved payload and explicit claim/dispatch/sent states', () => {
    const { store, enqueueApproved } = open()
    const approved = enqueueApproved({ bcc: ['audit@example.net'] })
    const claimed = store.claim(approved.id, 'worker-1', 1_000)
    expect(store.getOutbox(approved.id)?.status).toBe('claimed')
    expect(claimed).toMatchObject({
      outboxId: approved.id,
      snapshot: {
        accountId: 'acct_work', sendAsAddress: 'work@example.com',
        bcc: ['audit@example.net'], messageId: approved.snapshot.messageId,
      },
      lease: { owner: 'worker-1' },
    })
    expect(claimed.snapshot).not.toHaveProperty('path')
    expect(store.markDispatched(approved.id, 'worker-1').status).toBe('dispatched')
    expect(() => store.claim(approved.id, 'worker-2')).toThrow(/not approved/)
    expect(store.markSent(approved.id, 'gmail-message-1')).toMatchObject({
      status: 'sent', providerMessageId: 'gmail-message-1', leaseOwner: null,
    })
    expect(() => store.markSent(approved.id, 'again')).toThrow(/must be dispatched/)
  })

  it('reclaims an expired pre-dispatch claim without creating a dispatched retry path', () => {
    const { store, enqueueApproved, clock } = open()
    const approved = enqueueApproved()
    store.claim(approved.id, 'dead-worker', 10)
    expect(() => store.claim(approved.id, 'early-worker')).toThrow(/expired pre-dispatch/)
    clock.now += 10
    const reclaimed = store.claim(approved.id, 'live-worker', 50)
    expect(reclaimed.lease.owner).toBe('live-worker')
    store.markDispatched(approved.id, 'live-worker')
    clock.now += 100
    expect(() => store.claim(approved.id, 'retry-worker')).toThrow(/not approved/)
  })

  it('edits stale claims but never rewrite a dispatched snapshot', () => {
    const { store, enqueueApproved, save } = open()
    const claimed = enqueueApproved()
    store.claim(claimed.id, 'worker')
    save({ bodyMarkdown: 'edited before dispatch' })
    expect(store.getOutbox(claimed.id)?.status).toBe('stale')
    expect(() => store.markDispatched(claimed.id, 'worker')).toThrow(/must be claimed/)

    const second = enqueueApproved({ path: 'drafts/second.mail.md' })
    store.claim(second.id, 'worker')
    store.markDispatched(second.id, 'worker')
    save({ path: 'drafts/second.mail.md', bodyMarkdown: 'edited after dispatch' })
    expect(store.getOutbox(second.id)?.status).toBe('dispatched')
  })

  it('revalidates identity at claim and immediately before dispatch', () => {
    const { store, enqueueApproved } = open()
    const first = enqueueApproved()
    store.upsertAccount({
      accountId: 'acct_work', providerSourceId: 7, primaryAddress: 'work@example.com',
      sendAs: ['work@example.com'], connected: false,
    })
    expect(() => store.claim(first.id, 'worker')).toThrow(/disconnected/)

    store.upsertAccount({
      accountId: 'acct_work', providerSourceId: 7, primaryAddress: 'work@example.com',
      sendAs: ['work@example.com', 'alias@example.com'], connected: true,
    })
    const alias = enqueueApproved({ path: 'drafts/alias.mail.md', sendAsAddress: 'alias@example.com' })
    store.claim(alias.id, 'worker')
    store.upsertAccount({
      accountId: 'acct_work', providerSourceId: 7, primaryAddress: 'work@example.com', sendAs: ['work@example.com'],
    })
    expect(() => store.markDispatched(alias.id, 'worker')).toThrow(/not provider-authorised/)
  })

  it('validates positive finite lease durations and lease ownership', () => {
    const { store, enqueueApproved } = open()
    const approved = enqueueApproved()
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.claim(approved.id, 'worker', duration)).toThrow(/positive finite/)
    }
    store.claim(approved.id, 'worker', 100)
    expect(() => store.markDispatched(approved.id, 'other')).toThrow(/not held/)
  })

  it('moves ambiguous dispatch to unknown with attention and reconciles atomically to sent', () => {
    const { store, enqueueApproved } = open()
    const approved = enqueueApproved()
    store.claim(approved.id, 'worker')
    store.markDispatched(approved.id, 'worker')
    expect(store.markUnknown(approved.id, 'connection reset after upload').status).toBe('unknown')
    expect(() => store.claim(approved.id, 'retry')).toThrow(/not approved/)
    const attention = store.listAttention()
    expect(attention).toHaveLength(1)
    expect(attention[0].kind).toBe('send_unknown')

    expect(store.reconcileUnknownAsSent(approved.id, 'gmail-confirmed')).toMatchObject({
      status: 'sent', providerMessageId: 'gmail-confirmed',
    })
    expect(store.listAttention()).toEqual([])
    expect(store.listAttention(false).find((item) => item.id === attention[0].id)?.resolvedAt).not.toBeNull()
  })

  it('recovers expired post-dispatch leases to unknown once, never to claimed', () => {
    const { store, enqueueApproved, clock } = open()
    const approved = enqueueApproved()
    store.claim(approved.id, 'crashed-worker', 10)
    store.markDispatched(approved.id, 'crashed-worker')
    clock.now += 10
    expect(store.recoverExpired()).toHaveLength(1)
    expect(store.getOutbox(approved.id)?.status).toBe('unknown')
    expect(store.recoverExpired()).toEqual([])
    expect(store.listAttention().filter((item) => item.kind === 'send_unknown')).toHaveLength(1)
  })

  it('allows explicit human attention resolution', () => {
    const { store, save } = open()
    store.enqueue(save().id)
    const item = store.listAttention()[0]
    expect(store.resolveAttention(item.id).resolvedAt).not.toBeNull()
    expect(store.listAttention()).toEqual([])
  })
})
