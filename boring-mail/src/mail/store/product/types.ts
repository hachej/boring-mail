export type OutboxStatus =
  | 'pending_approval'
  | 'approved'
  | 'claimed'
  | 'dispatched'
  | 'sent'
  | 'unknown'
  | 'rejected'
  | 'stale'

export type AttentionKind = 'approval_required' | 'send_unknown'

export interface MailAttachment {
  name: string
  mimeType: string
  contentHash: string
  size: number
}

export interface ReplyTarget {
  rfc822MessageId: string
  sourceId: number
}

export interface DraftInput {
  path: string
  accountId: string
  sendAsAddress: string
  reply?: ReplyTarget
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyMarkdown: string
  attachments?: MailAttachment[]
}

export interface DraftRecord {
  readonly id: string
  readonly path: string
  readonly revision: number
  readonly accountId: string
  readonly sendAsAddress: string
  readonly reply?: Readonly<ReplyTarget>
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly bodyMarkdown: string
  readonly attachments: readonly Readonly<MailAttachment>[]
  readonly contentDigest: string
}

/** Complete immutable envelope/content approved for one provider request. */
export interface SendSnapshot {
  readonly accountId: string
  readonly sendAsAddress: string
  readonly reply?: Readonly<ReplyTarget>
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly bodyMarkdown: string
  readonly attachments: readonly Readonly<MailAttachment>[]
  readonly messageId: string
}

export interface OutboxRecord {
  id: string
  draftId: string
  draftRevision: number
  status: OutboxStatus
  snapshot: SendSnapshot
  contentDigest: string
  approvalExpiresAt: number | null
  approvalConsumedAt: number | null
  leaseOwner: string | null
  leaseExpiresAt: number | null
  providerMessageId: string | null
}

export interface ClaimedSend {
  readonly outboxId: string
  readonly draftId: string
  readonly draftRevision: number
  readonly contentDigest: string
  readonly snapshot: SendSnapshot
  readonly lease: Readonly<{ owner: string; expiresAt: number }>
}

export interface AttentionItem {
  id: string
  kind: AttentionKind
  accountId: string
  outboxId: string
  title: string
  detail: string
  createdAt: number
  resolvedAt: number | null
}

export interface AccountInput {
  accountId: string
  providerSourceId: number
  primaryAddress: string
  sendAs: string[]
  connected?: boolean
}

export interface ProductStoreDependencies {
  now: () => number
  verifyReplyOwnership: (rfc822MessageId: string, sourceId: number) => boolean
}

export type ProductStoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'invalid_transition'
  | 'identity_revoked'
  | 'approval_backlog'
  | 'approval_invalid'
  | 'approval_expired'
  | 'content_changed'
  | 'lease_invalid'
  | 'unsupported_schema'

export class ProductStoreError extends Error {
  constructor(readonly code: ProductStoreErrorCode, message: string) {
    super(message)
    this.name = 'ProductStoreError'
  }
}
