// Synthetic unified-inbox projection tests; no personal data.
// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  explainUnifiedInboxQueryPlan,
  hasMessageAtSource,
  listUnifiedInbox,
  openMsgvaultStore,
  resolveReplyTarget,
} from '../src/mail/store/msgvaultAdapter.js'

const SCHEMA = readFileSync(new URL('./fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8')

describe('msgvaultAdapter — unified inbox projection', () => {
  let raw: DatabaseSync
  let store: { db: DatabaseSync }
  const eligible = [
    { sourceId: 1, identities: ['owner-a@example.com', 'alias-a@example.com'] },
    { sourceId: 2, identities: ['owner-b@example.com'] },
  ]
  const authority = { scope: 'fixture-process' }

  beforeAll(() => {
    const path = join(mkdtempSync(join(tmpdir(), 'msgvault-unified-')), 'fixture.db')
    raw = new DatabaseSync(path)
    raw.exec('PRAGMA journal_mode=WAL')
    raw.exec(SCHEMA)
    raw.exec(`
      INSERT INTO sources(id,source_type,identifier) VALUES
        (1,'gmail','owner-a@example.com'), (2,'gmail','owner-b@example.com'),
        (3,'gmail','disconnected@example.com'), (4,'gmail','unregistered@example.com');
      INSERT INTO conversations(id,source_id,source_conversation_id,conversation_type) VALUES
        (11,1,'a-1','email_thread'), (12,2,'b-1','email_thread'),
        (13,3,'c-1','email_thread'), (14,4,'d-1','email_thread'),
        (15,2,'b-calendar','calendar');
      INSERT INTO participants(id,email_address,display_name,domain) VALUES
        (1001,'ALIAS-A@example.com',NULL,'example.com'),
        (1002,'alias-a@example.com',NULL,'example.com'),
        (1003,'owner-b@example.com',NULL,'example.com'),
        (1004,'disconnected@example.com',NULL,'example.com');
    `)
    const insert = raw.prepare(`INSERT INTO messages(
      id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,
      is_read,attachment_count,deleted_at,deleted_from_source_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    const message = (
      id: number, conversationId: number, sourceId: number, rfc822: string | null,
      sentAt: string | null, subject: string, deletedAt: string | null = null,
      deletedFromSourceAt: string | null = null, messageType = 'email',
    ) => insert.run(
      id, conversationId, sourceId, rfc822, messageType, sentAt, subject,
      id === 101 ? 0 : 1, id === 601 ? 1 : 0, deletedAt, deletedFromSourceAt,
    )

    // Alias-addressed source 1 wins over a newer non-addressed source 2 copy.
    message(101, 11, 1, '<alias@example.com>', '2030-01-07 00:00:00+00:00', 'alias owner')
    message(102, 12, 2, '<alias@example.com>', '2030-01-08 00:00:00+00:00', 'newer other')
    raw.exec(`INSERT INTO message_recipients(message_id,participant_id,recipient_type,email_address)
      VALUES(101,1001,'To','ALIAS-A@example.com')`)

    // Cc is addressed; when both copies are addressed, newest addressed wins.
    message(201, 11, 1, '<cc@example.com>', '2030-01-05 00:00:00+00:00', 'older cc')
    message(202, 12, 2, '<cc@example.com>', '2030-01-06 00:00:00+00:00', 'newer to')
    raw.exec(`INSERT INTO message_recipients(message_id,participant_id,recipient_type,email_address) VALUES
      (201,1002,'cc','alias-a@example.com'),(202,1003,'TO','owner-b@example.com')`)

    // Bcc is addressed even with provider casing; it beats a newer unaddressed copy.
    message(211, 11, 1, '<bcc@example.com>', '2030-01-04 12:00:00+00:00', 'older bcc')
    message(212, 12, 2, '<bcc@example.com>', '2030-01-04 18:00:00+00:00', 'newer unaddressed')
    raw.exec(`INSERT INTO message_recipients(message_id,participant_id,recipient_type,email_address)
      VALUES(211,1001,'BcC','ALIAS-A@example.com')`)

    // No addressed account: newest copy wins, then source id is stable.
    message(301, 11, 1, '<newest@example.com>', '2030-01-03 00:00:00+00:00', 'older fallback')
    message(302, 12, 2, '<newest@example.com>', '2030-01-04 00:00:00+00:00', 'newest fallback')
    message(401, 12, 2, '<stable@example.com>', '2030-01-02 00:00:00+00:00', 'source two')
    message(402, 11, 1, '<stable@example.com>', '2030-01-02 00:00:00+00:00', 'source one')

    message(601, 11, 1, '<single@example.com>', '2030-01-01 00:00:00+00:00', 'singleton')
    message(602, 11, 1, null, '2029-12-31 00:00:00+00:00', 'missing id')
    message(603, 12, 2, '<equal-b@example.com>', '2029-12-30 00:00:00+00:00', 'equal b')
    message(604, 11, 1, '<equal-a@example.com>', '2029-12-30 00:00:00+00:00', 'equal a')
    message(605, 11, 1, '<null-time-a@example.com>', null, 'null time a')
    message(606, 12, 2, '<null-time-b@example.com>', null, 'null time b')

    // Every unsupported shape remains row-distinct and cannot be a reply target.
    const malformed = [
      'not-an-id', '<@domain>', '<local@>', '<a@b@c>', '<<a@b>>', '<a b@c>',
      '<a\tb@c>', '<a\u0001b@c>', '<a,b@x>', '<a..b@x>', '<a@-x>', '<漢@x>',
    ]
    malformed.forEach((id, index) => {
      message(700 + index * 2, 11, 1, id, `2029-12-${String(20 - index).padStart(2, '0')} 00:00:00+00:00`, 'bad a')
      message(701 + index * 2, 12, 2, id, `2029-12-${String(19 - index).padStart(2, '0')} 00:00:00+00:00`, 'bad b')
    })

    // Ineligible copies neither win nor count.
    message(501, 11, 1, '<connected@example.com>', '2029-11-01 00:00:00+00:00', 'connected')
    message(502, 13, 3, '<connected@example.com>', '2032-01-01 00:00:00+00:00', 'disconnected addressed')
    message(503, 14, 4, '<unregistered@example.com>', '2032-01-01 00:00:00+00:00', 'unregistered')
    raw.exec(`INSERT INTO message_recipients(message_id,participant_id,recipient_type,email_address)
      VALUES(502,1004,'to','disconnected@example.com')`)

    // An email-typed row in a non-email conversation cannot count or win.
    message(550, 11, 1, '<mixed-conversation@example.com>', '2029-10-30 00:00:00+00:00', 'replyable copy')
    message(551, 15, 2, '<mixed-conversation@example.com>', '2034-01-01 00:00:00+00:00', 'calendar copy')
    raw.exec(`INSERT INTO message_recipients(message_id,participant_id,recipient_type,email_address)
      VALUES(551,1003,'to','owner-b@example.com')`)

    // Both deletion forms and non-email rows never surface.
    message(801, 11, 1, '<local-delete@example.com>', '2033-01-01 00:00:00+00:00', 'local deleted', 'gone')
    message(802, 12, 2, '<provider-delete@example.com>', '2033-01-01 00:00:00+00:00', 'provider deleted', null, 'gone')
    message(803, 11, 1, '<calendar@example.com>', '2033-01-01 00:00:00+00:00', 'calendar', null, null, 'calendar')
    store = openMsgvaultStore(path)
  })

  afterAll(() => raw.close())

  it('uses all authorized identities and keeps winner identity fields coherent', () => {
    const items = listUnifiedInbox(store.db, eligible, authority, { limit: 50 }).items
    expect(items.find((item) => item.rfc822MessageId === '<alias@example.com>')).toMatchObject({
      messageId: 101, conversationId: 11, sourceId: 1,
      sourceIdentifier: 'owner-a@example.com', subject: 'alias owner', unread: true,
      coalesced: true, copyCount: 2,
    })
    expect(items.find((item) => item.rfc822MessageId === '<cc@example.com>')).toMatchObject({
      messageId: 202, conversationId: 12, sourceId: 2, coalesced: true, copyCount: 2,
    })
    const bcc = items.find((item) => item.rfc822MessageId === '<bcc@example.com>')
    expect(bcc).toMatchObject({
      messageId: 211, conversationId: 11, sourceId: 1,
      sourceIdentifier: 'owner-a@example.com', subject: 'older bcc',
      coalesced: true, copyCount: 2,
    })
    expect(resolveReplyTarget(store.db, bcc!.messageId)).toEqual({
      rfc822MessageId: '<bcc@example.com>', sourceId: 1,
    })
    expect(items.find((item) => item.rfc822MessageId === '<newest@example.com>')).toMatchObject({
      messageId: 302, sourceId: 2, coalesced: true,
    })
    expect(items.find((item) => item.rfc822MessageId === '<stable@example.com>')).toMatchObject({
      messageId: 402, sourceId: 1, coalesced: true,
    })
  })

  it('excludes disconnected/unregistered/deleted copies before selection and counting', () => {
    const items = listUnifiedInbox(store.db, eligible, authority, { limit: 50 }).items
    expect(items.find((item) => item.rfc822MessageId === '<connected@example.com>')).toMatchObject({
      messageId: 501, sourceId: 1, coalesced: false, copyCount: 1,
    })
    expect(items.some((item) => [502, 503, 551, 801, 802, 803].includes(item.messageId))).toBe(false)
    expect(items.find((item) => item.rfc822MessageId === '<mixed-conversation@example.com>')).toMatchObject({
      messageId: 550, sourceId: 1, coalesced: false, copyCount: 1,
    })
  })

  it('returns only replyable ownership for every correlated item', () => {
    const items = listUnifiedInbox(store.db, eligible, authority, { limit: 200 }).items
    for (const item of items) {
      if (item.rfc822MessageId === null) continue
      expect(resolveReplyTarget(store.db, item.messageId)).toEqual({
        rfc822MessageId: item.rfc822MessageId,
        sourceId: item.sourceId,
      })
    }
  })

  it('keeps null/malformed identities distinct and rejects them as reply targets', () => {
    const items = listUnifiedInbox(store.db, eligible, authority, { limit: 50 }).items
    const ids = [
      602, 700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711,
      712, 713, 714, 715, 716, 717, 718, 719, 720, 721, 722, 723,
    ]
    for (const id of ids) {
      expect(items.find((item) => item.messageId === id)).toMatchObject({
        rfc822MessageId: null, coalesced: false, copyCount: 1,
      })
      expect(resolveReplyTarget(store.db, id)).toBeNull()
    }
    expect(hasMessageAtSource(store.db, 'not-an-id', 1)).toBe(false)
    expect(resolveReplyTarget(store.db, 101)).toEqual({ rfc822MessageId: '<alias@example.com>', sourceId: 1 })
  })

  it('traverses exact keyset order through equal and null timestamps without overlap', () => {
    const expected = [
      101, 202, 211, 302, 402, 601, 602, 604, 603,
      700, 702, 701, 704, 703, 706, 705, 708, 707, 710, 709, 712, 711,
      714, 713, 716, 715, 718, 717, 720, 719, 722, 721, 723, 501, 550, 606, 605,
    ]
    const seen: number[] = []
    let cursor: string | undefined
    do {
      const page = listUnifiedInbox(store.db, eligible, authority, { limit: 3, ...(cursor ? { cursor } : {}) })
      seen.push(...page.items.map((item) => item.messageId))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length)
    expect(listUnifiedInbox(store.db, eligible, authority, { limit: 200 }).nextCursor).toBeNull()
  })

  it('strictly decodes opaque cursors and invalidates eligibility, process and archive changes', () => {
    const first = listUnifiedInbox(store.db, eligible, authority, { limit: 2 })
    expect(first.nextCursor).toEqual(expect.any(String))
    const cursor = first.nextCursor!
    expect(() => listUnifiedInbox(store.db, eligible, authority, { cursor: '' })).toThrow(/malformed/)
    expect(() => listUnifiedInbox(store.db, eligible, authority, { cursor: `${cursor}=` })).toThrow(/malformed/)
    expect(() => listUnifiedInbox(store.db, eligible, authority, { cursor: `${cursor}x` })).toThrow(/malformed/)
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
    const extraKey = Buffer.from(JSON.stringify({ ...payload, extra: true })).toString('base64url')
    expect(() => listUnifiedInbox(store.db, eligible, authority, { cursor: extraKey })).toThrow(/invalid payload/)
    const reordered = Buffer.from(JSON.stringify({
      s: payload.s, v: payload.v, d: payload.d, e: payload.e, t: payload.t, i: payload.i,
    })).toString('base64url')
    expect(() => listUnifiedInbox(store.db, eligible, authority, { cursor: reordered })).toThrow(/not canonical/)
    expect(() => listUnifiedInbox(
      store.db, eligible.slice(0, 1), authority, { cursor },
    )).toThrowError(expect.objectContaining({ code: 'stale_cursor' }))
    expect(() => listUnifiedInbox(
      store.db, eligible, { scope: 'replacement-process' }, { cursor },
    )).toThrowError(expect.objectContaining({ code: 'stale_cursor' }))

    try {
      raw.exec(`INSERT INTO messages(
        id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count
      ) VALUES(900,11,1,'<sync@example.com>','email','2035-01-01 00:00:00+00:00','sync',1,0)`)
      expect(() => listUnifiedInbox(store.db, eligible, authority, { cursor })).toThrowError(
        expect.objectContaining({ code: 'stale_cursor' }),
      )
    } finally {
      raw.exec('DELETE FROM messages WHERE id=900')
    }
  })

  it('discards a page when msgvault commits between generation validation and the query', () => {
    const first = listUnifiedInbox(store.db, eligible, authority, { limit: 2 })
    try {
      expect(() => listUnifiedInbox(store.db, eligible, {
        scope: authority.scope,
        beforePageQuery: () => raw.exec(`INSERT INTO messages(
          id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count
        ) VALUES(901,11,1,'<race@example.com>','email','2035-01-01 00:00:00+00:00','race',1,0)`),
      }, { cursor: first.nextCursor! })).toThrowError(expect.objectContaining({ code: 'stale_cursor' }))
    } finally {
      raw.exec('DELETE FROM messages WHERE id=901')
    }
  })

  it('uses the live-recency index for the production outer page scan', () => {
    const plan = explainUnifiedInboxQueryPlan(store.db, eligible)
    expect(plan.some((detail) => /candidate USING INDEX idx_messages_live_sent_at/.test(detail))).toBe(true)
    expect(plan.some((detail) => /candidate USING (?:COVERING )?INDEX idx_messages_rfc822/.test(detail))).toBe(false)
    const after = { messageAt: '2029-12-31 00:00:00+00:00', messageId: 602 }
    const deepPlan = explainUnifiedInboxQueryPlan(store.db, eligible, after)
    expect(deepPlan.some((detail) => /SEARCH candidate USING INDEX idx_messages_live_sent_at/.test(detail))).toBe(true)
    const fallbackPlan = explainUnifiedInboxQueryPlan(store.db, eligible, after, 'source-fallback')
    expect(fallbackPlan.some((detail) => /SEARCH candidate USING INDEX idx_messages_source/.test(detail))).toBe(true)
  })

  it('fails loudly on malformed storage classes and invalid page input', () => {
    raw.prepare(`INSERT INTO sources(id,source_type,identifier) VALUES(5,'gmail',?)`).run(Buffer.from('bad'))
    raw.exec(`INSERT INTO conversations(id,source_id,conversation_type) VALUES(17,5,'email_thread');
      INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
      VALUES(950,17,5,'<bad-storage@example.com>','email','2036-01-01',1,0)`)
    expect(() => listUnifiedInbox(
      store.db, [{ sourceId: 5, identities: ['bad@example.com'] }], authority,
    )).toThrow(/source_identifier must be non-empty text/)
    raw.exec(`INSERT INTO sources(id,source_type,identifier) VALUES(6,'gmail','time@example.com');
      INSERT INTO conversations(id,source_id,conversation_type) VALUES(18,6,'email_thread');
      INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
      VALUES(951,18,6,'<bad-time@example.com>','email','2036-01-01T00:00:00+01:00',1,0)`)
    expect(() => listUnifiedInbox(
      store.db, [{ sourceId: 6, identities: ['time@example.com'] }], authority,
    )).toThrowError(expect.objectContaining({ code: 'corrupt_data', message: expect.stringMatching(/canonical UTC/) }))
    expect(() => listUnifiedInbox(store.db, eligible, authority, { limit: 0 })).toThrow(/limit must/)
    expect(() => listUnifiedInbox(store.db, eligible, authority, { limit: 201 })).toThrow(/limit must/)
    expect(() => listUnifiedInbox(
      store.db, eligible, authority, null as unknown as Parameters<typeof listUnifiedInbox>[3],
    )).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    expect(() => listUnifiedInbox(
      store.db, eligible, authority, { unexpected: true } as unknown as Parameters<typeof listUnifiedInbox>[3],
    )).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
  })
})
