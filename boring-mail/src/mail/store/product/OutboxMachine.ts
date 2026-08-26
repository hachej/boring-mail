import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { decodeAttention, decodeDraft, decodeOutbox, type DraftRow, type OutboxRow } from './codec.js'
import { fail, StoreContext } from './context.js'
import { createSendSnapshot, sendSnapshotDigest } from './sendSnapshot.js'
import {
  ProductStoreError,
  type ApprovedOutbox,
  type AttentionItem,
  type CancelledOutbox,
  type ClaimedOutbox,
  type DispatchedOutbox,
  type FailedOutbox,
  type HumanDecisionOutbox,
  type OutboxRecord,
  type PendingOutbox,
  type RejectedOutbox,
  type SendSnapshot,
  type SentOutbox,
  type UnknownOutbox,
} from './types.js'
const APPROVAL_TTL = 300_000,
  LEASE = 60_000,
  RECONCILE_DEADLINE = 15 * 60_000,
  MAX_BACKOFF = 5 * 60_000
const hash = (value: string): Buffer => createHash('sha256').update(value).digest()
const sameBuffer = (hex: string, actual: Buffer): boolean => {
  const expected = Buffer.from(hex, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
/** Domain-separated, unambiguous binding for the complete approval authority. */
const approvalVerifier = (token: string, sessionId: string, outboxId: string, digest: string): Buffer =>
  hash(JSON.stringify(['boring-mail.approval.v1', token, sessionId, outboxId, digest]))
export class OutboxMachine {
  constructor(private readonly c: StoreContext) {}
  get(id: string): OutboxRecord | null {
    return this.c.outbox(id)
  }
  listAttention(openOnly = true): AttentionItem[] {
    const rows = this.c.db
      .prepare(
        `SELECT * FROM mail_attention ${openOnly ? 'WHERE resolved_ms IS NULL' : ''} ORDER BY created_ms,id`,
      )
      .all() as Array<Record<string, unknown>>
    return rows.map(decodeAttention)
  }
  private attention(
    kind: AttentionItem['kind'],
    account: string,
    outbox: string,
    title: string,
    detail: string,
    now: number,
  ): void {
    this.c.db
      .prepare(
        `INSERT INTO mail_attention(id,kind,account_id,outbox_id,title,detail,created_ms) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(randomUUID(), kind, account, outbox, title, detail, now)
  }
  private resolve(outbox: string, kind: AttentionItem['kind'], now: number): void {
    this.c.db
      .prepare(`UPDATE mail_attention SET resolved_ms=? WHERE outbox_id=? AND kind=? AND resolved_ms IS NULL`)
      .run(now, outbox, kind)
  }
  private pendingCount(account: string): number {
    return Number(
      (
        this.c.db
          .prepare(`SELECT COUNT(*) count FROM mail_outbox WHERE account_id=? AND status='pending_approval'`)
          .get(account) as { count: number }
      ).count,
    )
  }
  private insert(
    draftId: string,
    revision: number,
    snapshot: SendSnapshot,
    retryOf: string | null,
    now: number,
  ): PendingOutbox {
    if (this.pendingCount(snapshot.accountId) >= 5)
      fail('approval_backlog', 'maximum 5 pending approvals per account')
    const id = randomUUID(),
      digest = sendSnapshotDigest(snapshot)
    this.c.db
      .prepare(
        `INSERT INTO mail_outbox(id,draft_id,draft_revision,account_id,send_as_address,reply_message_id,reply_rfc822_message_id,reply_source_id,to_json,cc_json,bcc_json,subject,body_markdown,attachments_json,message_id,content_digest,status,retry_of,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_approval',?,?,?)`,
      )
      .run(
        id,
        draftId,
        revision,
        snapshot.accountId,
        snapshot.sendAsAddress,
        snapshot.reply?.messageId ?? null,
        snapshot.reply?.rfc822MessageId ?? null,
        snapshot.reply?.sourceId ?? null,
        JSON.stringify(snapshot.to),
        JSON.stringify(snapshot.cc),
        JSON.stringify(snapshot.bcc),
        snapshot.subject,
        snapshot.bodyMarkdown,
        JSON.stringify(snapshot.attachments),
        snapshot.messageId,
        digest,
        retryOf,
        now,
        now,
      )
    this.attention(
      'approval_required',
      snapshot.accountId,
      id,
      `Approve: ${snapshot.subject}`,
      retryOf ? 'Human-authorised retry; duplicate delivery is possible' : draftId,
      now,
    )
    return this.get(id) as PendingOutbox
  }
  enqueue(draftId: string): PendingOutbox {
    return this.c.transaction(() => {
      const row = this.c.db.prepare(`SELECT * FROM mail_drafts WHERE id=?`).get(draftId) as unknown as
        | DraftRow
        | undefined
      if (!row) throw new ProductStoreError('not_found', `draft ${draftId} not found`)
      const draft = decodeDraft(row)
      this.c.assertIdentity(draft)
      return this.insert(draft.id, draft.revision, createSendSnapshot(draft), null, this.c.now())
    })
  }
  issueApprovalCapability(id: string, sessionId: string, ttl = APPROVAL_TTL): string {
    if (!sessionId.trim()) fail('invalid_input', 'authenticated session id is required')
    return this.c.transaction(() => {
      const { row } = this.c.require(id, 'pending_approval')
      this.digest(row)
      const token = randomBytes(32).toString('base64url'),
        now = this.c.now(),
        expires = this.c.deadline(now, ttl, 'approval TTL')
      this.c.db.prepare(
        `UPDATE mail_outbox SET approval_cap_hash=?,approval_session_hash=?,approval_expires_ms=?,updated_ms=? WHERE id=?`,
      ).run(
        approvalVerifier(token, sessionId, id, String(row.content_digest)).toString('hex'),
        hash(sessionId).toString('hex'), expires, now, id,
      )
      return token
    })
  }
  approve(id: string, token: string, sessionId: string): ApprovedOutbox {
    return this.c.transaction(() => {
      if (!sessionId.trim()) fail('approval_invalid', 'authenticated session id is required')
      const { row, record } = this.c.require(id, 'pending_approval')
      this.digest(row)
      this.c.assertIdentity(record.snapshot)
      const now = this.c.now(),
        expires = row.approval_expires_ms
      if (!Number.isSafeInteger(expires) || Number(expires) <= now)
        fail('approval_expired', 'approval capability expired or malformed')
      if (typeof row.approval_cap_hash !== 'string' || typeof row.approval_session_hash !== 'string') {
        fail('approval_invalid', 'approval capability was not issued')
      }
      const verifierMatches = sameBuffer(
        row.approval_cap_hash,
        approvalVerifier(token, sessionId, id, String(row.content_digest)),
      )
      const sessionMatches = sameBuffer(row.approval_session_hash, hash(sessionId))
      if (!verifierMatches || !sessionMatches) {
        fail('approval_invalid', 'approval capability or session binding invalid')
      }
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='approved',approval_cap_hash=NULL,approval_session_hash=NULL,approval_expires_ms=NULL,approval_consumed_ms=?,updated_ms=? WHERE id=?`,
        )
        .run(now, now, id)
      this.resolve(id, 'approval_required', now)
      return this.c.require(id, 'approved').record
    })
  }
  reject(id: string): RejectedOutbox {
    return this.c.transaction(() => {
      this.c.require(id, 'pending_approval')
      const now = this.c.now()
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='rejected',approval_cap_hash=NULL,approval_session_hash=NULL,approval_expires_ms=NULL,updated_ms=? WHERE id=?`,
        )
        .run(now, id)
      this.resolve(id, 'approval_required', now)
      return this.c.require(id, 'rejected').record
    })
  }
  claim(id: string, worker: string, leaseMs = LEASE): ClaimedOutbox {
    if (!worker.trim()) fail('invalid_input', 'worker id is required')
    return this.c.transaction(() => {
      const { row, record } = this.c.require(id)
      const now = this.c.now(),
        reclaim = record.status === 'claimed' && record.lease.expiresAt <= now
      if (record.status !== 'approved' && !reclaim)
        fail('invalid_transition', 'outbox is not approved or an expired claim')
      this.c.assertIdentity(record.snapshot)
      this.digest(row)
      const expires = this.c.deadline(now, leaseMs, 'send lease')
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='claimed',lease_owner=?,lease_expires_ms=?,updated_ms=? WHERE id=?`,
        )
        .run(worker, expires, now, id)
      return this.c.require(id, 'claimed').record
    })
  }
  markDispatched(id: string, worker: string, preDispatchHistoryId: string): DispatchedOutbox {
    if (!/^\d+$/.test(preDispatchHistoryId)) fail('invalid_input', 'pre-dispatch history id must be nonempty numeric text')
    return this.c.transaction(() => {
      const { row, record } = this.c.require(id, 'claimed')
      const now = this.c.now()
      if (record.lease.owner !== worker || record.lease.expiresAt <= now)
        fail('lease_invalid', 'send claim is not held by this worker or has expired')
      this.c.assertIdentity(record.snapshot)
      this.digest(row)
      this.c.db.prepare(
        `UPDATE mail_outbox SET status='dispatched',pre_dispatch_history_id=?,updated_ms=? WHERE id=?`,
      ).run(preDispatchHistoryId, now, id)
      return this.c.require(id, 'dispatched').record
    })
  }
  markSent(id: string, worker: string, providerId: string): SentOutbox {
    if (!providerId.trim()) fail('invalid_input', 'provider message id is required')
    return this.dispatchedResult(id, worker, 'sent', () =>
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='sent',lease_owner=NULL,lease_expires_ms=NULL,provider_message_id=?,delivery_basis='provider',updated_ms=? WHERE id=?`,
        )
        .run(providerId, this.c.now(), id),
    )
  }
  markFailed(id: string, worker: string, code: string, detail: string): FailedOutbox {
    if (!code.trim()) fail('invalid_input', 'failure code is required')
    return this.dispatchedResult(id, worker, 'failed', () =>
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='failed',lease_owner=NULL,lease_expires_ms=NULL,failure_code=?,failure_detail=?,updated_ms=? WHERE id=?`,
        )
        .run(code, detail, this.c.now(), id),
    )
  }
  markUnknown(id: string, worker: string, detail: string, deadlineMs = RECONCILE_DEADLINE): UnknownOutbox {
    return this.dispatchedResult(id, worker, 'unknown', () => {
      const now = this.c.now(),
        deadline = this.c.deadline(now, deadlineMs, 'reconciliation deadline')
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='unknown',lease_owner=NULL,lease_expires_ms=NULL,reconcile_deadline_ms=?,reconcile_next_ms=?,reconcile_attempts=0,reconcile_detail=?,updated_ms=? WHERE id=?`,
        )
        .run(deadline, now, detail, now, id)
    })
  }
  private dispatchedResult<S extends 'sent' | 'failed' | 'unknown'>(
    id: string, worker: string, status: S, mutate: () => unknown,
  ): Extract<OutboxRecord, { status: S }> {
    return this.c.transaction(() => {
      const { record } = this.c.require(id, 'dispatched')
      if (record.lease.owner !== worker) fail('lease_invalid', 'dispatched send is owned by another worker')
      mutate()
      return this.c.require(id, status).record
    })
  }
  cancel(id: string): CancelledOutbox {
    return this.c.transaction(() => {
      const { record } = this.c.require(id)
      if (record.status !== 'approved' && record.status !== 'claimed')
        fail('invalid_transition', 'only approved or claimed sends may be cancelled')
      const now = this.c.now()
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='cancelled',lease_owner=NULL,lease_expires_ms=NULL,terminal_reason='cancelled',updated_ms=? WHERE id=?`,
        )
        .run(now, id)
      return this.c.require(id, 'cancelled').record
    })
  }
  recoverExpired(): UnknownOutbox[] {
    return this.c.transaction(() => {
      const now = this.c.now(),
        rows = this.c.db
          .prepare(`SELECT * FROM mail_outbox WHERE status='dispatched' AND lease_expires_ms<=?`)
          .all(now) as unknown as OutboxRow[]
      for (const row of rows) {
        const record = decodeOutbox(row)
        if (record.status !== 'dispatched') continue
        const deadline = this.c.deadline(now, RECONCILE_DEADLINE, 'reconciliation deadline')
        this.c.db
          .prepare(
            `UPDATE mail_outbox SET status='unknown',lease_owner=NULL,lease_expires_ms=NULL,reconcile_deadline_ms=?,reconcile_next_ms=?,reconcile_attempts=0,reconcile_detail='worker lease expired after dispatch',updated_ms=? WHERE id=? AND status='dispatched'`,
          )
          .run(deadline, now, now, record.id)
      }
      return rows.map((row) => this.c.require(String(row.id), 'unknown').record)
    })
  }
  dueReconciliations(limit = 100): UnknownOutbox[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) fail('invalid_input', 'limit must be positive')
    const rows = this.c.db
      .prepare(
        `SELECT * FROM mail_outbox WHERE status='unknown' AND reconcile_next_ms<=? ORDER BY reconcile_next_ms,id LIMIT ?`,
      )
      .all(this.c.now(), limit) as unknown as OutboxRow[]
    return rows.map(decodeOutbox).filter((x): x is UnknownOutbox => x.status === 'unknown')
  }
  reconciliationFound(id: string, providerId: string): SentOutbox {
    if (!providerId.trim()) fail('invalid_input', 'provider message id is required')
    return this.c.transaction(() => {
      const { record } = this.c.require(id)
      if (record.status !== 'unknown' && record.status !== 'human_decision') {
        fail('invalid_transition', `outbox must be unknown or human_decision; found ${record.status}`)
      }
      const now = this.c.now()
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='sent',reconcile_deadline_ms=NULL,reconcile_next_ms=NULL,reconcile_attempts=NULL,reconcile_detail=NULL,provider_message_id=?,delivery_basis='provider',updated_ms=? WHERE id=?`,
        )
        .run(providerId, now, id)
      if (record.status === 'human_decision') this.resolve(id, 'send_unknown', now)
      return this.c.require(id, 'sent').record
    })
  }
  reconciliationMiss(id: string, backoffMs: number): UnknownOutbox | HumanDecisionOutbox {
    return this.c.transaction(() => {
      const { record } = this.c.require(id, 'unknown')
      const now = this.c.now()
      if (record.reconciliation.nextAttemptAt > now) fail('invalid_transition', 'reconciliation is not due')
      if (!Number.isSafeInteger(backoffMs) || backoffMs <= 0 || backoffMs > MAX_BACKOFF)
        fail('invalid_input', 'reconciliation backoff is out of bounds')
      const attempts = record.reconciliation.attempts + 1
      if (now >= record.reconciliation.deadlineAt) {
        this.c.db
          .prepare(
            `UPDATE mail_outbox SET status='human_decision',reconcile_next_ms=NULL,reconcile_attempts=?,updated_ms=? WHERE id=?`,
          )
          .run(attempts, now, id)
        this.attention(
          'send_unknown',
          record.snapshot.accountId,
          id,
          'Send outcome unknown',
          record.reconciliation.detail,
          now,
        )
      } else {
        const next = Math.min(now + backoffMs, record.reconciliation.deadlineAt)
        this.c.db
          .prepare(`UPDATE mail_outbox SET reconcile_next_ms=?,reconcile_attempts=?,updated_ms=? WHERE id=?`)
          .run(next, attempts, now, id)
      }
      const updated = this.c.outbox(id)!
      if (updated.status !== 'unknown' && updated.status !== 'human_decision')
        fail('corrupt_data', 'invalid reconciliation result')
      return updated
    })
  }
  keepWaiting(id: string, durationMs = RECONCILE_DEADLINE): UnknownOutbox {
    return this.c.transaction(() => {
      const { record } = this.c.require(id, 'human_decision')
      const now = this.c.now(),
        deadline = this.c.deadline(now, durationMs, 'reconciliation deadline')
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='unknown',reconcile_deadline_ms=?,reconcile_next_ms=?,updated_ms=? WHERE id=?`,
        )
        .run(deadline, now, now, id)
      this.resolve(id, 'send_unknown', now)
      return this.c.require(id, 'unknown').record
    })
  }
  markHumanSent(id: string): SentOutbox {
    return this.c.transaction(() => {
      this.c.require(id, 'human_decision')
      const now = this.c.now()
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='sent',reconcile_deadline_ms=NULL,reconcile_next_ms=NULL,reconcile_attempts=NULL,reconcile_detail=NULL,delivery_basis='human',updated_ms=? WHERE id=?`,
        )
        .run(now, id)
      this.resolve(id, 'send_unknown', now)
      return this.c.require(id, 'sent').record
    })
  }
  retry(id: string): PendingOutbox {
    return this.c.transaction(() => {
      const { record } = this.c.require(id, 'human_decision')
      const now = this.c.now(),
        snapshot = createSendSnapshot(record.snapshot)
      this.c.db
        .prepare(
          `UPDATE mail_outbox SET status='cancelled',reconcile_deadline_ms=NULL,reconcile_next_ms=NULL,reconcile_attempts=NULL,reconcile_detail=NULL,terminal_reason='retry',updated_ms=? WHERE id=?`,
        )
        .run(now, id)
      this.resolve(id, 'send_unknown', now)
      return this.insert(record.draftId, record.draftRevision, snapshot, id, now)
    })
  }
  private digest(row: OutboxRow): void {
    const decoded = decodeOutbox(row)
    if (sendSnapshotDigest(decoded.snapshot) !== decoded.contentDigest)
      fail('content_changed', 'send snapshot content digest mismatch')
  }
}
