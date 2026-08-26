export type OutboxStatus =
  | 'pending_approval'
  | 'approved'
  | 'claimed'
  | 'dispatched'
  | 'unknown'
  | 'human_decision'
  | 'sent'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'stale'

export type AttentionKind = 'approval_required' | 'send_unknown'

export interface MailAttachment {
  name: string
  mimeType: string
  contentHash: string
  size: number
}
export interface ResolvedReplyTarget {
  messageId: number
  rfc822MessageId: string
  sourceId: number
}
interface DraftFields {
  path: string
  sendAsAddress: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyMarkdown: string
  attachments?: MailAttachment[]
}
export interface ComposeDraftInput extends DraftFields {
  kind: 'compose'
  accountId: string
}
export interface ReplyDraftInput extends DraftFields {
  kind: 'reply'
  replyToMessageId: number
}
export type DraftInput = ComposeDraftInput | ReplyDraftInput

export interface SendContent {
  readonly accountId: string
  readonly sendAsAddress: string
  readonly reply?: Readonly<ResolvedReplyTarget>
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly bodyMarkdown: string
  readonly attachments: readonly Readonly<MailAttachment>[]
}
export interface DraftRecord extends SendContent {
  readonly id: string
  readonly path: string
  readonly revision: number
  readonly contentDigest: string
}
export interface SendSnapshot extends SendContent {
  readonly messageId: string
}

interface OutboxBase {
  readonly id: string
  readonly draftId: string
  readonly draftRevision: number
  readonly snapshot: SendSnapshot
  readonly contentDigest: string
  readonly retryOf: string | null
}
export interface PendingOutbox extends OutboxBase {
  status: 'pending_approval'
  approvalExpiresAt: number | null
}
export interface ApprovedOutbox extends OutboxBase {
  status: 'approved'
  approvalConsumedAt: number
}
export interface ClaimedOutbox extends OutboxBase {
  status: 'claimed'
  approvalConsumedAt: number
  lease: { owner: string; expiresAt: number }
}
interface PostDispatchEvidence {
  /** Gmail history cursor captured in the same transaction that commits dispatch. */
  readonly preDispatchHistoryId: string
}
export interface DispatchedOutbox extends OutboxBase, PostDispatchEvidence {
  status: 'dispatched'
  approvalConsumedAt: number
  lease: { owner: string; expiresAt: number }
}
export interface UnknownOutbox extends OutboxBase, PostDispatchEvidence {
  status: 'unknown'
  approvalConsumedAt: number
  reconciliation: { deadlineAt: number; nextAttemptAt: number; attempts: number; detail: string }
}
export interface HumanDecisionOutbox extends OutboxBase, PostDispatchEvidence {
  status: 'human_decision'
  approvalConsumedAt: number
  reconciliation: { deadlineAt: number; attempts: number; detail: string }
}
export interface SentOutbox extends OutboxBase, PostDispatchEvidence {
  status: 'sent'
  approvalConsumedAt: number
  delivery: { basis: 'provider'; providerMessageId: string } | { basis: 'human'; providerMessageId: null }
}
export interface FailedOutbox extends OutboxBase, PostDispatchEvidence {
  status: 'failed'
  approvalConsumedAt: number
  failure: { code: string; detail: string }
}
export interface RejectedOutbox extends OutboxBase {
  status: 'rejected'
}
export interface CancelledOutbox extends OutboxBase {
  status: 'cancelled'
  approvalConsumedAt: number
  reason: 'cancelled' | 'retry'
  /** Present only when a human chose retry after an ambiguous dispatch. */
  preDispatchHistoryId: string | null
}
export interface StaleOutbox extends OutboxBase {
  status: 'stale'
  approvalConsumedAt: number | null
}
export type OutboxRecord =
  | PendingOutbox
  | ApprovedOutbox
  | ClaimedOutbox
  | DispatchedOutbox
  | UnknownOutbox
  | HumanDecisionOutbox
  | SentOutbox
  | FailedOutbox
  | RejectedOutbox
  | CancelledOutbox
  | StaleOutbox
export type ClaimedSend = ClaimedOutbox

export interface AttentionItem {
  readonly id: string
  readonly kind: AttentionKind
  readonly accountId: string
  readonly outboxId: string
  readonly title: string
  readonly detail: string
  readonly createdAt: number
  readonly resolvedAt: number | null
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
  resolveReplyTarget: (messageId: number) => Omit<ResolvedReplyTarget, 'messageId'> | null
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
  | 'corrupt_data'
export class ProductStoreError extends Error {
  constructor(
    readonly code: ProductStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProductStoreError'
  }
}
