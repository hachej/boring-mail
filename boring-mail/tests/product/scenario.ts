import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openProductStore,
  type DraftInput,
  type ProductStore,
  type ProductStoreDependencies,
} from '../../src/mail/store/productDb.js'

export const reply = { rfc822MessageId: '<inbound@example.net>', sourceId: 7 }

export function draft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    path: 'drafts/reply.mail.md',
    accountId: 'acct_work',
    sendAsAddress: 'work@example.com',
    reply,
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
  owned: Set<string>
  close(): void
  save(overrides?: Partial<DraftInput>, id?: string): ReturnType<ProductStore['saveDraft']>
  enqueueApproved(overrides?: Partial<DraftInput>): ReturnType<ProductStore['enqueue']>
}

export function scenario(depsOverride: Partial<ProductStoreDependencies> = {}): Scenario {
  const path = join(mkdtempSync(join(tmpdir(), 'boring-product-')), 'boring-mail.db')
  const clock = { now: 1_800_000_000_000 }
  const owned = new Set([`${reply.sourceId}:${reply.rfc822MessageId}`])
  const store = openProductStore(path, {
    now: () => clock.now,
    verifyReplyOwnership: (messageId, sourceId) => owned.has(`${sourceId}:${messageId}`),
    ...depsOverride,
  })
  store.upsertAccount({
    accountId: 'acct_work',
    providerSourceId: 7,
    primaryAddress: 'work@example.com',
    sendAs: ['work@example.com', 'alias@example.com'],
  })
  const result: Scenario = {
    path,
    store,
    clock,
    owned,
    close: () => store.close(),
    save: (overrides = {}, id) => store.saveDraft(draft(overrides), id),
    enqueueApproved: (overrides = {}) => {
      const saved = store.saveDraft(draft(overrides))
      const queued = store.enqueue(saved.id)
      const token = store.issueApprovalCapability(queued.id)
      return store.approve(queued.id, token)
    },
  }
  return result
}
