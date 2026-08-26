import { isContentDigest, isGeneratedMessageId, normalizeDraftPath, sendContentIssue } from './sendSnapshot.js'
import {
  ProductStoreError,
  type AttentionItem,
  type DraftRecord,
  type MailAttachment,
  type OutboxRecord,
  type OutboxStatus,
  type SendContent,
  type SendSnapshot,
} from './types.js'
export interface SendRow {
  account_id: unknown
  send_as_address: unknown
  reply_message_id: unknown
  reply_rfc822_message_id: unknown
  reply_source_id: unknown
  to_json: unknown
  cc_json: unknown
  bcc_json: unknown
  subject: unknown
  body_markdown: unknown
  attachments_json: unknown
}
export interface DraftRow extends SendRow {
  id: unknown
  path: unknown
  revision: unknown
  content_digest: unknown
}
export interface OutboxRow extends SendRow {
  id: unknown
  draft_id: unknown
  draft_revision: unknown
  message_id: unknown
  content_digest: unknown
  status: unknown
  approval_cap_hash: unknown
  approval_session_hash: unknown
  approval_expires_ms: unknown
  approval_consumed_ms: unknown
  lease_owner: unknown
  lease_expires_ms: unknown
  reconcile_deadline_ms: unknown
  reconcile_next_ms: unknown
  reconcile_attempts: unknown
  reconcile_detail: unknown
  provider_message_id: unknown
  delivery_basis: unknown
  failure_code: unknown
  failure_detail: unknown
  terminal_reason: unknown
  retry_of: unknown
  pre_dispatch_history_id: unknown
}
function corrupt(message: string): never {
  throw new ProductStoreError('corrupt_data', message)
}
function str(v: unknown, name: string): string {
  if (typeof v !== 'string') corrupt(`${name} must be text`)
  return v as string
}
function nullableStr(v: unknown, name: string): string | null {
  return v === null ? null : str(v, name)
}
function integer(v: unknown, name: string): number {
  if (!Number.isSafeInteger(v)) corrupt(`${name} must be a safe integer`)
  return v as number
}
function nullableInt(v: unknown, name: string): number | null {
  return v === null ? null : integer(v, name)
}
function nonnegative(v: unknown, name: string): number {
  const value = integer(v, name)
  if (value < 0) corrupt(`${name} must be non-negative`)
  return value
}
function nullableNonnegative(v: unknown, name: string): number | null {
  return v === null ? null : nonnegative(v, name)
}
function parse(v: unknown, name: string): unknown {
  if (typeof v !== 'string') corrupt(`${name} must be JSON text`)
  try {
    return JSON.parse(v as string)
  } catch {
    return corrupt(`${name} contains malformed JSON`)
  }
}
function strings(v: unknown, name: string): string[] {
  const value = parse(v, name)
  if (!Array.isArray(value) || !value.every((x: unknown) => typeof x === 'string'))
    corrupt(`${name} must be a string array`)
  return value as string[]
}
function attachmentArray(v: unknown): MailAttachment[] {
  const value = parse(v, 'attachments')
  if (!Array.isArray(value)) corrupt('attachments must be an array')
  return (value as unknown[]).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      corrupt(`attachment ${index} must be an object`)
    const x = item as Record<string, unknown>
    if (
      typeof x.name !== 'string' ||
      typeof x.mimeType !== 'string' ||
      typeof x.contentHash !== 'string' ||
      !Number.isSafeInteger(x.size) ||
      Number(x.size) < 0
    )
      corrupt(`attachment ${index} has an invalid shape`)
    return {
      name: x.name as string,
      mimeType: x.mimeType as string,
      contentHash: x.contentHash as string,
      size: x.size as number,
    }
  })
}
export const decodeStringArray = (v: unknown, name: string): string[] => strings(v, name)
export function decodeSendContent(row: SendRow): SendContent {
  const m = nullableInt(row.reply_message_id, 'reply_message_id'),
    r = nullableStr(row.reply_rfc822_message_id, 'reply_rfc822_message_id'),
    s = nullableInt(row.reply_source_id, 'reply_source_id')
  if ((m === null) !== (r === null) || (m === null) !== (s === null))
    corrupt('reply target columns must be all null or all present')
  const content: SendContent = {
    accountId: str(row.account_id, 'account_id'),
    sendAsAddress: str(row.send_as_address, 'send_as_address'),
    ...(m !== null ? { reply: { messageId: m, rfc822MessageId: r!, sourceId: s! } } : {}),
    to: strings(row.to_json, 'to_json'),
    cc: strings(row.cc_json, 'cc_json'),
    bcc: strings(row.bcc_json, 'bcc_json'),
    subject: str(row.subject, 'subject'),
    bodyMarkdown: str(row.body_markdown, 'body_markdown'),
    attachments: attachmentArray(row.attachments_json),
  }
  const issue = sendContentIssue(content)
  if (issue) corrupt(issue)
  return content
}
function nonempty(v: unknown, name: string): string {
  const value = str(v, name)
  if (!value) corrupt(`${name} must be nonempty`)
  return value
}
function positive(v: unknown, name: string): number {
  const value = integer(v, name)
  if (value <= 0) corrupt(`${name} must be positive`)
  return value
}
function durablePath(v: unknown): string {
  const value = str(v, 'draft.path')
  try {
    if (normalizeDraftPath(value) !== value) corrupt('draft.path must be canonical')
  } catch {
    corrupt('draft.path must be a canonical safe .mail.md path')
  }
  return value
}
function digest(v: unknown, name: string): string {
  const value = str(v, name)
  if (!isContentDigest(value)) corrupt(`${name} must be a lowercase SHA-256 digest`)
  return value
}
export function decodeDraft(row: DraftRow): DraftRecord {
  return {
    id: nonempty(row.id, 'draft.id'),
    path: durablePath(row.path),
    revision: positive(row.revision, 'draft.revision'),
    ...decodeSendContent(row),
    contentDigest: digest(row.content_digest, 'draft.content_digest'),
  }
}
const statuses = new Set<OutboxStatus>([
  'pending_approval',
  'approved',
  'claimed',
  'dispatched',
  'unknown',
  'human_decision',
  'sent',
  'failed',
  'rejected',
  'cancelled',
  'stale',
])
export function decodeOutbox(row: OutboxRow): OutboxRecord {
  const status = str(row.status, 'status') as OutboxStatus
  if (!statuses.has(status)) corrupt(`unknown outbox status ${status}`)
  const messageId = str(row.message_id, 'message_id')
  if (!isGeneratedMessageId(messageId)) corrupt('message_id has invalid generated shape')
  const retryOf = nullableStr(row.retry_of, 'retry_of')
  if (retryOf === '') corrupt('retry_of must be null or nonempty')
  const base = {
    id: nonempty(row.id, 'outbox.id'),
    draftId: nonempty(row.draft_id, 'draft_id'),
    draftRevision: positive(row.draft_revision, 'draft_revision'),
    snapshot: { ...decodeSendContent(row), messageId } as SendSnapshot,
    contentDigest: digest(row.content_digest, 'content_digest'),
    retryOf,
  }
  const capHash = nullableStr(row.approval_cap_hash, 'approval_cap_hash'),
    sessionHash = nullableStr(row.approval_session_hash, 'approval_session_hash'),
    approvalExpiry = nullableNonnegative(row.approval_expires_ms, 'approval_expires_ms'),
    consumed = nullableNonnegative(row.approval_consumed_ms, 'approval_consumed_ms'),
    owner = nullableStr(row.lease_owner, 'lease_owner'),
    lease = nullableNonnegative(row.lease_expires_ms, 'lease_expires_ms'),
    deadline = nullableNonnegative(row.reconcile_deadline_ms, 'reconcile_deadline_ms'),
    next = nullableNonnegative(row.reconcile_next_ms, 'reconcile_next_ms'),
    attempts = nullableNonnegative(row.reconcile_attempts, 'reconcile_attempts'),
    detail = nullableStr(row.reconcile_detail, 'reconcile_detail'),
    historyId = nullableStr(row.pre_dispatch_history_id, 'pre_dispatch_history_id')
  if (historyId !== null && !/^\d+$/.test(historyId)) corrupt('pre_dispatch_history_id must be numeric text')
  const capabilityParts = [capHash, sessionHash, approvalExpiry]
  if (capabilityParts.some((value) => value !== null) && capabilityParts.some((value) => value === null)) {
    corrupt('approval capability columns must be all null or all present')
  }
  if (
    (capHash !== null && !/^[0-9a-f]{64}$/.test(capHash)) ||
    (sessionHash !== null && !/^[0-9a-f]{64}$/.test(sessionHash))
  ) {
    corrupt('approval capability hashes are malformed')
  }
  switch (status) {
    case 'pending_approval':
      if (historyId !== null) corrupt('pending row may not contain dispatch history')
      return { ...base, status, approvalExpiresAt: approvalExpiry }
    case 'approved': {
      if (historyId !== null) corrupt('approved row may not contain dispatch history')
      if (consumed === null) corrupt('approved row lacks approval consumption')
      return { ...base, status, approvalConsumedAt: consumed! }
    }
    case 'claimed': {
      if (consumed === null || owner === null || lease === null || historyId !== null)
        corrupt('claimed row has invalid approval, lease or dispatch history')
      return { ...base, status, approvalConsumedAt: consumed, lease: { owner, expiresAt: lease } }
    }
    case 'dispatched': {
      if (consumed === null || owner === null || lease === null || historyId === null)
        corrupt('dispatched row lacks approval, lease or history cursor')
      return { ...base, status, approvalConsumedAt: consumed, lease: { owner, expiresAt: lease }, preDispatchHistoryId: historyId }
    }
    case 'unknown': {
      if (consumed === null || deadline === null || next === null || attempts === null || detail === null)
        corrupt('unknown row lacks reconciliation state')
      return {
        ...base,
        status,
        approvalConsumedAt: consumed!,
        preDispatchHistoryId: historyId ?? corrupt('unknown row lacks history cursor'),
        reconciliation: { deadlineAt: deadline!, nextAttemptAt: next!, attempts: attempts!, detail: detail! },
      }
    }
    case 'human_decision': {
      if (consumed === null || deadline === null || attempts === null || detail === null)
        corrupt('human-decision row lacks reconciliation state')
      return {
        ...base,
        status,
        approvalConsumedAt: consumed!,
        preDispatchHistoryId: historyId ?? corrupt('human-decision row lacks history cursor'),
        reconciliation: { deadlineAt: deadline!, attempts: attempts!, detail: detail! },
      }
    }
    case 'sent': {
      if (consumed === null) corrupt('sent row lacks approval')
      const basis = nullableStr(row.delivery_basis, 'delivery_basis'),
        provider = nullableStr(row.provider_message_id, 'provider_message_id')
      if (basis === 'provider' && provider)
        return {
          ...base,
          status,
          approvalConsumedAt: consumed!,
          preDispatchHistoryId: historyId ?? corrupt('sent row lacks history cursor'),
          delivery: { basis, providerMessageId: provider },
        }
      if (basis === 'human' && provider === null)
        return {
          ...base,
          status,
          approvalConsumedAt: consumed!,
          preDispatchHistoryId: historyId ?? corrupt('sent row lacks history cursor'),
          delivery: { basis, providerMessageId: null },
        }
      return corrupt('sent row has invalid delivery evidence')
    }
    case 'failed': {
      const code = nullableStr(row.failure_code, 'failure_code'),
        failureDetail = nullableStr(row.failure_detail, 'failure_detail')
      if (consumed === null || !code || failureDetail === null) corrupt('failed row lacks failure evidence')
      return {
        ...base,
        status,
        approvalConsumedAt: consumed!,
        preDispatchHistoryId: historyId ?? corrupt('failed row lacks history cursor'),
        failure: { code: code!, detail: failureDetail! },
      }
    }
    case 'rejected':
      if (consumed !== null || historyId !== null) corrupt('rejected row has approval or dispatch evidence')
      return { ...base, status }
    case 'cancelled': {
      const reason = nullableStr(row.terminal_reason, 'terminal_reason')
      if (consumed === null || (reason !== 'cancelled' && reason !== 'retry') ||
          (reason === 'retry') !== (historyId !== null)) corrupt('cancelled row lacks valid reason/history evidence')
      return { ...base, status, approvalConsumedAt: consumed, reason, preDispatchHistoryId: historyId }
    }
    case 'stale':
      if (historyId !== null) corrupt('stale row may not contain dispatch history')
      return { ...base, status, approvalConsumedAt: consumed }
  }
}
export function decodeAttention(row: Record<string, unknown>): AttentionItem {
  const raw = str(row.kind, 'attention.kind')
  if (raw !== 'approval_required' && raw !== 'send_unknown') corrupt('unknown attention kind')
  const kind = raw as AttentionItem['kind']
  return {
    id: nonempty(row.id, 'attention.id'),
    kind,
    accountId: nonempty(row.account_id, 'attention.account_id'),
    outboxId: nonempty(row.outbox_id, 'attention.outbox_id'),
    title: str(row.title, 'attention.title'),
    detail: str(row.detail, 'attention.detail'),
    createdAt: nonnegative(row.created_ms, 'attention.created_ms'),
    resolvedAt: nullableNonnegative(row.resolved_ms, 'attention.resolved_ms'),
  }
}
