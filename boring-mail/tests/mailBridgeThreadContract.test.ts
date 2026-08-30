// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  mailBridgeThreadInputContract,
  mailBridgeThreadOutputContract,
  mapUnifiedThreadToBrowserThread,
} from '../src/mail/bridge/mailBridgeThreadContract.js'
import type { UnifiedThreadDetail } from '../src/mail/store/product/types.js'

function fixtureDetail(): UnifiedThreadDetail {
  return {
    selectedMessageId: 2,
    subject: 'Hello "thread" 😀',
    historyTruncated: false,
    selectedOutsideRecentWindow: false,
    replyCapability: { allowed: false, reason: 'drafts_not_in_scope' },
    messages: [1, 2, 3].map((id) => ({
      messageId: id,
      selected: id === 2,
      sentAt: `2030-01-0${id} 00:00:00+00:00`,
      sender: { name: `Sender ${id}`, email: `sender-${id}@example.invalid` },
      recipients: [{ type: 'to', name: `Recipient ${id}`, email: `recipient-${id}@example.invalid` }],
      bodyText: id === 2 ? 'selected reserve '.repeat(1024) : `body ${id} " \\ 😀 `.repeat(512),
      bodyUnavailable: false,
      bodyTruncated: false,
      attachments: [{ filename: `file-${id}.txt`, mimeType: 'text/plain', byteSize: id }],
      metadataTruncated: false,
    })),
  }
}

describe('mailBridgeThreadContract', () => {
  it('strictly validates input target shape and output vocabulary', () => {
    expect(mailBridgeThreadInputContract.safeParse({ target: 'bm1.123.abc_DEF-09' }).success).toBe(true)
    expect(mailBridgeThreadInputContract.safeParse({ target: 'x'.repeat(161) }).success).toBe(false)
    expect(mailBridgeThreadInputContract.safeParse({ target: 'ok', extra: true }).success).toBe(false)
    expect(mailBridgeThreadOutputContract.safeParse({ status: 'unavailable' }).success).toBe(true)
    expect(mailBridgeThreadOutputContract.safeParse({ status: 'missing' }).success).toBe(false)
  })

  it('maps only browser-safe fields and strips controls without source/provider authority metadata', () => {
    const output = mapUnifiedThreadToBrowserThread(fixtureDetail(), 'bm1.2.fixture')
    expect(output.status).toBe('ok')
    if (output.status !== 'ok') return
    expect(output.thread.subject).toBe('Hello "thread" 😀')
    expect(output.thread.replyCapability).toEqual({ allowed: false, reason: 'drafts_not_in_scope' })
    expect(output.thread.messages).toHaveLength(3)
    expect(output.thread.messages[0]).not.toHaveProperty('messageId')
    expect(output.thread.messages[1].bodyText).toContain('selected reserve')
    expect(output.thread.messages.every((message) => message.sentAt?.endsWith('.000Z'))).toBe(true)
    expect(JSON.stringify(output)).not.toMatch(/sourceId|conversationId|rfc822|bodyHtml|storagePath|contentHash|provider/i)
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThan(480 * 1024)
  })

  it('rejects corrupt internal DTOs before browser mapping', () => {
    const missingSelected = fixtureDetail()
    missingSelected.messages = missingSelected.messages.map((message) => ({ ...message, selected: false }))
    expect(() => mapUnifiedThreadToBrowserThread(missingSelected, 'bm1.2.fixture')).toThrow(/exactly one selected/)
    const overBudget = fixtureDetail()
    overBudget.messages[0].bodyText = 'x'.repeat(64 * 1024 + 1)
    expect(() => mapUnifiedThreadToBrowserThread(overBudget, 'bm1.2.fixture')).toThrow(/64 KiB/)
  })

  it('deterministically trims escaped hostile JSON while preserving the selected message body', () => {
    const detail = fixtureDetail()
    detail.selectedMessageId = 13
    detail.messages = Array.from({ length: 25 }, (_, index) => ({
      messageId: index + 1,
      selected: index === 12,
      sentAt: `2030-01-${String(index + 1).padStart(2, '0')} 00:00:00+00:00`,
      sender: { name: '"'.repeat(512), email: `sender-${index}@example.invalid` },
      recipients: Array.from({ length: 2 }, (_unused, recipient) => ({ type: 'to' as const, name: '"'.repeat(512), email: `r-${index}-${recipient}@example.invalid` })),
      bodyText: index === 12 ? 'SELECTED '.repeat(1024) : '"\\'.repeat(3072),
      bodyUnavailable: false,
      bodyTruncated: false,
      attachments: Array.from({ length: 2 }, (_unused, attachment) => ({ filename: '"'.repeat(1024), mimeType: 'text/plain', byteSize: attachment })),
      metadataTruncated: false,
    }))
    const output = mapUnifiedThreadToBrowserThread(detail, 'bm1.13.fixture')
    expect(output.status).toBe('ok')
    if (output.status !== 'ok') return
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThan(480 * 1024)
    expect(output.thread.messages.some((message) => message.bodyText.includes('SELECTED'))).toBe(true)
    expect(output.thread.messages).toHaveLength(25)
    expect(output.thread.messages.some((message) => message.bodyTruncated || message.metadataTruncated || !message.bodyText)).toBe(true)
  })
})
