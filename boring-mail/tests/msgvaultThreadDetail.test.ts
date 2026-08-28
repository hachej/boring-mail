// Synthetic thread-detail projection tests; no personal data.
// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  explainThreadDetailQueryPlans,
  getUnifiedThreadInSnapshot,
  openMsgvaultStore,
} from '../src/mail/store/msgvaultAdapter.js'

const SCHEMA = readFileSync(new URL('./fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8')
const eligible = [{ sourceId: 1, identities: ['owner@example.invalid'] }]

function stamp(day: number): string {
  return `2030-01-${String(day).padStart(2, '0')} 00:00:00+00:00`
}

describe('msgvaultAdapter — bounded authorized thread detail', () => {
  let raw: DatabaseSync
  let store: { db: DatabaseSync }

  beforeAll(() => {
    const path = join(mkdtempSync(join(tmpdir(), 'msgvault-thread-')), 'fixture.db')
    raw = new DatabaseSync(path)
    raw.exec('PRAGMA journal_mode=WAL')
    raw.exec(SCHEMA)
    raw.exec(`
      INSERT INTO sources(id,source_type,identifier) VALUES
        (1,'gmail','owner@example.invalid'), (2,'gmail','other@example.invalid'), (3,'gmail','gone@example.invalid');
      INSERT INTO conversations(id,source_id,source_conversation_id,conversation_type) VALUES
        (10,1,'c-10','email_thread'), (20,2,'c-20','email_thread'),
        (30,1,'calendar','calendar'), (40,1,'many','email_thread'), (50,1,'bad','email_thread');
      INSERT INTO participants(id,email_address,display_name,domain) VALUES
        (1,'sender@example.invalid','Sender Name','example.invalid'),
        (2,'owner@example.invalid','Owner Name','example.invalid');
      INSERT INTO account_identities(source_id,address) VALUES(1,'owner@example.invalid'),(2,'other@example.invalid');
    `)
    const insert = raw.prepare(`INSERT INTO messages(
      id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,sender_id,is_read,attachment_count,deleted_at,deleted_from_source_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (let id = 1; id <= 30; id++) {
      insert.run(id, 10, 1, `<m-${id}@example.invalid>`, 'email', stamp(id), id === 1 ? null : `subject ${id}`, 1, 1, 0, null, null)
      raw.prepare(`INSERT INTO message_bodies(message_id,body_text,body_html) VALUES(?,?,?)`).run(
        id,
        id === 1 ? `selected C0\u0000 quote " slash \\ astral 😀 ${'x'.repeat(4096)}` : `body ${id}`,
        '<b>html must never be selected</b>',
      )
    }
    raw.exec(`
      INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count,deleted_at,deleted_from_source_at)
        VALUES(101,20,2,'<other@example.invalid>','email','2031-01-01 00:00:00+00:00','other',1,0,NULL,NULL),
              (102,10,2,'<cross@example.invalid>','email','2031-01-02 00:00:00+00:00','cross source',1,0,NULL,NULL),
              (103,10,1,'<deleted@example.invalid>','email','2031-01-03 00:00:00+00:00','deleted',1,0,'gone',NULL),
              (104,10,1,'<calendar-row@example.invalid>','calendar','2031-01-04 00:00:00+00:00','calendar row',1,0,NULL,NULL),
              (105,30,1,'<calendar-conv@example.invalid>','email','2031-01-05 00:00:00+00:00','calendar conv',1,0,NULL,NULL),
              (106,50,1,'<bad-time@example.invalid>','email','not utc','bad time',1,0,NULL,NULL);
    `)
    for (let id = 1; id <= 25; id++) {
      raw.prepare(`INSERT INTO message_recipients(id,message_id,participant_id,recipient_type,display_name,email_address) VALUES(?,?,?,?,?,?)`).run(
        id, 30, 2, id === 23 ? 'reply-to' : id % 3 === 0 ? 'bcc' : id % 2 === 0 ? 'cc' : 'to',
        `Recipient ${id}`, id === 24 ? null : `recipient-${id}@example.invalid`,
      )
      raw.prepare(`INSERT INTO attachments(id,message_id,filename,mime_type,size,content_hash,storage_path) VALUES(?,?,?,?,?,?,?)`).run(
        id, 30, id === 25 ? null : `file-${id}.txt`, 'text/plain', id === 24 ? -1 : id, `hash-${id}`, `/private/${id}`,
      )
    }
    for (let id = 1001; id <= 1505; id++) {
      const offset = id - 1000
      insert.run(id, 40, 1, `<many-${offset}@example.invalid>`, 'email', `2032-01-${String(((offset - 1) % 28) + 1).padStart(2, '0')} 00:00:00+00:00`, `many ${offset}`, 1, 1, 0, null, null)
      raw.prepare(`INSERT INTO message_bodies(message_id,body_text,body_html) VALUES(?,?,?)`).run(id, `many body ${offset}`, '<i>html</i>')
    }
    store = openMsgvaultStore(path)
  })

  afterAll(() => { store?.db.close(); raw?.close() })

  it('derives authority from the selected row and fails closed for disconnected/cross-source/deleted/non-email ids', () => {
    expect(getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 1 })?.selectedMessageId).toBe(1)
    for (const id of [101, 102, 103, 104, 105]) {
      expect(getUnifiedThreadInSnapshot(store.db, eligible, { messageId: id })).toBeNull()
    }
    expect(() => getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 0 })).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    expect(() => getUnifiedThreadInSnapshot(store.db, eligible, { messageId: Number.MAX_SAFE_INTEGER + 1 })).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
  })

  it('always retains the selected message and reports exact recent-window flags', () => {
    const detail = getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 1 })!
    expect(detail.subject).toBe('(no subject)')
    expect(detail.messages).toHaveLength(25)
    expect(detail.messages[0]).toMatchObject({ messageId: 1, selected: true })
    expect(detail.messages.slice(1).map((message) => message.messageId)).toEqual(Array.from({ length: 24 }, (_, index) => index + 7))
    expect(detail.selectedOutsideRecentWindow).toBe(true)
    expect(detail.historyTruncated).toBe(true)
    expect(detail.messages[0].bodyText).toContain('selected C0 quote')
    expect(detail.messages[0].bodyText).not.toContain('\u0000')
  })

  it('retains an old selected row beyond the 500 inspected candidates', () => {
    const detail = getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 1001 })!
    expect(detail.messages).toHaveLength(25)
    expect(detail.messages.some((message) => message.messageId === 1001 && message.selected)).toBe(true)
    expect(detail.selectedOutsideRecentWindow).toBe(true)
    expect(detail.historyTruncated).toBe(true)
  })

  it('bounds per-message fanout and omits corrupt source-mapping rows without provider authority metadata', () => {
    const detail = getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 30 })!
    const selected = detail.messages.find((message) => message.messageId === 30)!
    expect(selected.recipients).toHaveLength(20)
    expect(selected.recipients.every((recipient) => ['to', 'cc', 'bcc'].includes(recipient.type) && recipient.email.endsWith('@example.invalid'))).toBe(true)
    expect(selected.attachments).toHaveLength(20)
    expect(selected.attachments.every((attachment) => !('contentHash' in attachment) && !('storagePath' in attachment))).toBe(true)
    expect(selected.metadataTruncated).toBe(true)
  })

  it('fails unavailable-class corruption on malformed retained timestamp/text storage classes', () => {
    expect(() => getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 106 })).toThrowError(
      expect.objectContaining({ code: 'corrupt_data', message: expect.stringMatching(/canonical UTC/) }),
    )
    raw.prepare(`UPDATE messages SET subject=? WHERE id=1`).run(Buffer.from([0xff]))
    try {
      expect(() => getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 1 })).toThrowError(
        expect.objectContaining({ code: 'corrupt_data', message: expect.stringMatching(/subject storage class/) }),
      )
    } finally {
      raw.prepare(`UPDATE messages SET subject=NULL WHERE id=1`).run()
    }
  })

  it('uses bounded indexed plans with no temporary b-tree for hostile candidate and metadata queries', () => {
    const plan = explainThreadDetailQueryPlans(store.db, 30, eligible)
    expect(plan.candidates.some((detail) => /USING INDEX idx_messages_conversation/.test(detail))).toBe(true)
    expect(plan.recipients.some((detail) => /USING INDEX idx_message_recipients_message/.test(detail))).toBe(true)
    expect(plan.attachments.some((detail) => /USING INDEX idx_attachments_message/.test(detail))).toBe(true)
    expect([...plan.candidates, ...plan.recipients, ...plan.attachments].some((detail) => /TEMP B-TREE/i.test(detail))).toBe(false)
  })
})
