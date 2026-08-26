import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openProductStore,
  type ProductStore,
  type ProductStoreDependencies,
  type ReplyDraftInput,
} from '../../src/mail/store/productDb.js'
export const UI_SESSION = 'host-session-a'
export const reply = { messageId: 101, rfc822MessageId: '<inbound@example.net>', sourceId: 7 }
export function draft(overrides: Partial<ReplyDraftInput> = {}): ReplyDraftInput {
  return {
    kind: 'reply',
    path: 'drafts/reply.mail.md',
    replyToMessageId: reply.messageId,
    sendAsAddress: 'work@example.com',
    to: ['Client@Example.net'],
    cc: [],
    bcc: [],
    subject: 'Re: status',
    bodyMarkdown: 'Thanks — looks good.',
    attachments: [{ name: 'report.pdf', mimeType: 'application/pdf', contentHash: 'abc123', size: 42 }],
    ...overrides,
  }
}
export interface Scenario {
  path: string
  store: ProductStore
  clock: { now: number }
  targets: Map<number, { rfc822MessageId: string; sourceId: number }>
  close(): void
  save(overrides?: Partial<ReplyDraftInput>, id?: string): ReturnType<ProductStore['saveDraft']>
  enqueueApproved(overrides?: Partial<ReplyDraftInput>): ReturnType<ProductStore['outbox']['approve']>
}
export function scenario(deps: Partial<ProductStoreDependencies> = {}): Scenario {
  const path = join(mkdtempSync(join(tmpdir(), 'boring-product-')), 'boring-mail.db'),
    clock = { now: 1_800_000_000_000 },
    targets = new Map([
      [reply.messageId, { rfc822MessageId: reply.rfc822MessageId, sourceId: reply.sourceId }],
    ])
  const store = openProductStore(path, {
    now: () => clock.now,
    resolveReplyTarget: (id) => targets.get(id) ?? null,
    ...deps,
  })
  store.upsertAccount({
    accountId: 'acct_work',
    providerSourceId: 7,
    primaryAddress: 'work@example.com',
    sendAs: ['work@example.com', 'alias@example.com'],
  })
  return {
    path,
    store,
    clock,
    targets,
    close: () => store.close(),
    save: (o = {}, id) => store.saveDraft(draft(o), id),
    enqueueApproved: (o = {}) => {
      const queued = store.outbox.enqueue(store.saveDraft(draft(o)).id),
        token = store.outbox.issueApprovalCapability(queued.id, UI_SESSION)
      return store.outbox.approve(queued.id, token, UI_SESSION)
    },
  }
}
