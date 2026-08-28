// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  mailBridgeListInputContract,
  mailBridgeListOutputContract,
  mapUnifiedInboxPageToBrowserList,
} from '../src/mail/bridge/mailBridgeListContract.js'
import type { UnifiedInboxPage } from '../src/mail/store/product/types.js'

const page = (overrides: Partial<UnifiedInboxPage['items'][number]> = {}): UnifiedInboxPage => ({
  items: [{
    messageId: 101,
    conversationId: 500,
    sourceId: 7,
    sourceIdentifier: 'owner@example.invalid',
    rfc822MessageId: '<msg@example.invalid>',
    subject: null,
    snippet: null,
    senderName: null,
    senderEmail: null,
    messageAt: '2030-01-01 00:00:00+00:00',
    unread: true,
    hasAttachments: false,
    coalesced: false,
    copyCount: 1,
    textTruncated: { senderName: false, senderEmail: false, subject: false, snippet: false },
    ...overrides,
  }],
  nextCursor: null,
})

describe('mailBridgeListContract', () => {
  it('strictly validates list inputs and status vocabulary', () => {
    expect(mailBridgeListInputContract.safeParse({ limit: 50, cursor: 'abc' }).success).toBe(true)
    expect(mailBridgeListInputContract.safeParse({ limit: 51 }).success).toBe(false)
    expect(mailBridgeListInputContract.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(mailBridgeListInputContract.safeParse({ cursor: '' }).success).toBe(false)
    expect(mailBridgeListInputContract.safeParse({ unexpected: true }).success).toBe(false)
    expect(mailBridgeListOutputContract.safeParse({ status: 'stale_cursor' }).success).toBe(true)
    expect(mailBridgeListOutputContract.safeParse({ status: 'unavailable' }).success).toBe(true)
    expect(mailBridgeListOutputContract.safeParse({ status: 'stale-cursor' }).success).toBe(false)
  })

  it('maps storage rows to bounded browser DTOs without internal identifiers', () => {
    const output = mapUnifiedInboxPageToBrowserList(page({
      subject: '',
      snippet: 'hello\u0001 world',
      senderName: 'Cafe\u0301'.repeat(300),
      senderEmail: 'bad email@example.invalid',
      textTruncated: { senderName: true, senderEmail: false, subject: false, snippet: false },
    }), (id) => `bm1.${id}.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-`)
    expect(output.status).toBe('ok')
    if (output.status !== 'ok') throw new Error('expected ok output')
    expect(output.items).toHaveLength(1)
    expect(output.items[0]).toMatchObject({
      target: expect.stringMatching(/^bm1\.101\./),
      senderEmail: null,
      subject: '(no subject)',
      snippet: 'hello world',
    })
    expect(output.items[0].senderName).not.toContain('\u0301')
    expect(Buffer.byteLength(output.items[0].senderName ?? '', 'utf8')).toBeLessThanOrEqual(512)
    expect(output.items[0].truncated.senderName).toBe(true)
    expect(Object.keys(output.items[0]).sort()).toEqual([
      'coalesced', 'copyCount', 'hasAttachments', 'messageAt', 'senderEmail', 'senderName',
      'snippet', 'subject', 'target', 'truncated', 'unread',
    ].sort())
  })

  it('enforces 50 item and 480 KiB JSON caps instead of dropping rows', () => {
    const fullPage: UnifiedInboxPage = {
      items: Array.from({ length: 50 }, (_, index) => ({
        ...page().items[0]!,
        messageId: index + 1,
        subject: '😀'.repeat(2_000),
        snippet: '\\ \\" \\n '.repeat(4_000),
        senderName: 'Cafe\u0301'.repeat(1_000),
        senderEmail: `${index}@example.invalid`,
        textTruncated: { senderName: true, senderEmail: false, subject: true, snippet: true },
      })),
      nextCursor: 'cursor',
    }
    const output = mapUnifiedInboxPageToBrowserList(fullPage, (id) => `bm1.${id}.tag`)
    expect(output.status).toBe('ok')
    if (output.status !== 'ok') throw new Error('expected ok output')
    expect(output.items).toHaveLength(50)
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThan(480 * 1024)
    const tooMany: UnifiedInboxPage = {
      items: Array.from({ length: 51 }, (_, index) => ({ ...page().items[0]!, messageId: index + 1 })),
      nextCursor: null,
    }
    expect(() => mapUnifiedInboxPageToBrowserList(tooMany, (id) => `bm1.${id}.tag`)).toThrow(/50 items/)
  })
})
