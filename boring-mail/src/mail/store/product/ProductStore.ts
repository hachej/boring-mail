import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { migrateProductDatabase } from './migrations.js'
import {
  createSendSnapshot,
  draftContentDigest,
  normalizeDraft,
  sendContentFromRow,
  sendSnapshotDigest,
  snapshotFromRow,
  type NormalizedDraft,
  type SendContentRow,
  type SnapshotRow,
} from './sendSnapshot.js'
import {
  ProductStoreError,
  type AccountInput,
  type AttentionItem,
  type ClaimedSend,
  type DraftInput,
  type DraftRecord,
  type OutboxRecord,
  type OutboxStatus,
  type ProductStoreDependencies,
  type SendSnapshot,
} from './types.js'

interface AccountRow {
  provider_source_id: number
  send_as_json: string
  connected: number
}

interface DraftRow extends SendContentRow {
  id: string
  path: string
  revision: number
  content_digest: string
}

interface OutboxRow extends SnapshotRow {
  id: string
  draft_id: string
  draft_revision: number
  status: OutboxStatus
  content_digest: string
  approval_cap_hash: string | null
  approval_expires_ms: number | null
  approval_consumed_ms: number | null
  lease_owner: string | null
  lease_expires_ms: number | null
  provider_message_id: string | null
}

interface AttentionRow {
  id: string
  kind: AttentionItem['kind']
  account_id: string
  outbox_id: string
  title: string
  detail: string
  created_ms: number
  resolved_ms: number | null
}

const MAX_PENDING_APPROVALS_PER_ACCOUNT = 5
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000
const DEFAULT_LEASE_MS = 60_000

function fail(code: ConstructorParameters<typeof ProductStoreError>[0], message: string): never {
  throw new ProductStoreError(code, message)
}

function parseStringArray(json: string): string[] {
  return JSON.parse(json) as string[]
}

export class ProductStore {
  readonly #db: DatabaseSync
  readonly #deps: ProductStoreDependencies

  private constructor(db: DatabaseSync, deps: ProductStoreDependencies) {
    this.#db = db
    this.#deps = deps
  }

  static open(path: string, deps: ProductStoreDependencies): ProductStore {
    if (!deps || typeof deps.now !== 'function' || typeof deps.verifyReplyOwnership !== 'function') {
      fail('invalid_input', 'clock and trusted reply ownership dependency are required')
    }
    const db = new DatabaseSync(path)
    try {
      migrateProductDatabase(db)
      db.exec('PRAGMA foreign_keys = ON')
      return new ProductStore(db, deps)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    this.#db.close()
  }

  #now(): number {
    const now = this.#deps.now()
    if (!Number.isSafeInteger(now) || now < 0) fail('invalid_input', 'clock must return non-negative epoch milliseconds')
    return now
  }

  #deadline(now: number, durationMs: number, name: string): number {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      fail('invalid_input', `${name} must be a positive finite duration`)
    }
    const deadline = now + durationMs
    if (!Number.isSafeInteger(deadline)) fail('invalid_input', `${name} deadline exceeds safe integer range`)
    return deadline
  }

  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  upsertAccount(account: AccountInput): void {
    const accountId = account.accountId.trim()
    const primaryAddress = account.primaryAddress.trim().toLowerCase()
    if (!accountId || !primaryAddress || !Number.isSafeInteger(account.providerSourceId)) {
      fail('invalid_input', 'account id, primary address and integer provider source are required')
    }
    const sendAs = [...new Set(account.sendAs.map((address) => address.trim().toLowerCase()).filter(Boolean))]
    if (!sendAs.includes(primaryAddress)) sendAs.unshift(primaryAddress)
    const now = this.#now()
    this.#db.prepare(`
      INSERT INTO mail_accounts (
        account_id,provider_source_id,primary_address,send_as_json,connected,created_ms,updated_ms
      ) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET
        provider_source_id=excluded.provider_source_id,
        primary_address=excluded.primary_address,
        send_as_json=excluded.send_as_json,
        connected=excluded.connected,
        updated_ms=excluded.updated_ms
    `).run(
      accountId, account.providerSourceId, primaryAddress, JSON.stringify(sendAs),
      account.connected === false ? 0 : 1, now, now,
    )
  }

  #assertIdentity(snapshot: Pick<SendSnapshot, 'accountId' | 'sendAsAddress' | 'reply'>): void {
    const account = this.#db.prepare(`
      SELECT provider_source_id,send_as_json,connected FROM mail_accounts WHERE account_id=?
    `).get(snapshot.accountId) as AccountRow | undefined
    if (!account || account.connected !== 1) {
      fail('identity_revoked', `account ${snapshot.accountId} is disconnected or unknown`)
    }
    if (!parseStringArray(account.send_as_json).includes(snapshot.sendAsAddress)) {
      fail('identity_revoked', `send-as identity ${snapshot.sendAsAddress} is not provider-authorised`)
    }
    if (snapshot.reply && (
      account.provider_source_id !== snapshot.reply.sourceId ||
      !this.#deps.verifyReplyOwnership(snapshot.reply.rfc822MessageId, snapshot.reply.sourceId)
    )) {
      fail('identity_revoked', 'reply ownership is not present in trusted msgvault state')
    }
  }

  saveDraft(input: DraftInput, requestedId: string = randomUUID()): DraftRecord {
    const draft = normalizeDraft(input)
    this.#assertIdentity(draft)
    const digest = draftContentDigest(draft)
    return this.#transaction(() => {
      const existing = this.#db.prepare(`SELECT * FROM mail_drafts WHERE path=?`).get(draft.path) as DraftRow | undefined
      if (existing?.content_digest === digest) return this.#draftFromRow(existing)

      const now = this.#now()
      if (!existing) {
        this.#db.prepare(`
          INSERT INTO mail_drafts (
            id,path,revision,account_id,send_as_address,reply_rfc822_message_id,reply_source_id,
            to_json,cc_json,bcc_json,subject,body_markdown,attachments_json,content_digest,created_ms,updated_ms
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(...this.#draftWriteValues(requestedId, draft, 1, digest, now, now))
        return this.getDraft(requestedId)!
      }

      this.#db.prepare(`
        UPDATE mail_outbox SET status='stale',approval_cap_hash=NULL,approval_expires_ms=NULL,
          lease_owner=NULL,lease_expires_ms=NULL,updated_ms=?
        WHERE draft_id=? AND status IN ('pending_approval','approved','claimed')
      `).run(now, existing.id)
      this.#db.prepare(`
        UPDATE mail_attention SET resolved_ms=?
        WHERE kind='approval_required' AND resolved_ms IS NULL
          AND outbox_id IN (SELECT id FROM mail_outbox WHERE draft_id=? AND status='stale')
      `).run(now, existing.id)
      const revision = existing.revision + 1
      this.#db.prepare(`
        UPDATE mail_drafts SET revision=?,account_id=?,send_as_address=?,reply_rfc822_message_id=?,
          reply_source_id=?,to_json=?,cc_json=?,bcc_json=?,subject=?,body_markdown=?,attachments_json=?,
          content_digest=?,updated_ms=? WHERE id=?
      `).run(
        revision, draft.accountId, draft.sendAsAddress, draft.reply?.rfc822MessageId ?? null,
        draft.reply?.sourceId ?? null, JSON.stringify(draft.to), JSON.stringify(draft.cc),
        JSON.stringify(draft.bcc), draft.subject, draft.bodyMarkdown, JSON.stringify(draft.attachments),
        digest, now, existing.id,
      )
      return this.getDraft(existing.id)!
    })
  }

  #draftWriteValues(
    id: string, draft: NormalizedDraft, revision: number, digest: string, created: number, updated: number,
  ): Array<string | number | null> {
    return [
      id, draft.path, revision, draft.accountId, draft.sendAsAddress,
      draft.reply?.rfc822MessageId ?? null, draft.reply?.sourceId ?? null,
      JSON.stringify(draft.to), JSON.stringify(draft.cc), JSON.stringify(draft.bcc),
      draft.subject, draft.bodyMarkdown, JSON.stringify(draft.attachments), digest, created, updated,
    ]
  }

  getDraft(id: string): DraftRecord | null {
    const row = this.#db.prepare(`SELECT * FROM mail_drafts WHERE id=?`).get(id) as DraftRow | undefined
    return row ? this.#draftFromRow(row) : null
  }

  #draftFromRow(row: DraftRow): DraftRecord {
    return {
      id: row.id,
      path: row.path,
      revision: row.revision,
      ...sendContentFromRow(row),
      contentDigest: row.content_digest,
    }
  }

  enqueue(draftId: string): OutboxRecord {
    return this.#transaction(() => {
      const draftRow = this.#db.prepare(`SELECT * FROM mail_drafts WHERE id=?`).get(draftId) as DraftRow | undefined
      if (!draftRow) fail('not_found', `draft ${draftId} not found`)
      const draft = this.#draftFromRow(draftRow)
      this.#assertIdentity(draft)
      const pending = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM mail_outbox WHERE account_id=? AND status='pending_approval'
      `).get(draft.accountId) as { count: number }
      if (pending.count >= MAX_PENDING_APPROVALS_PER_ACCOUNT) {
        fail('approval_backlog', 'maximum 5 pending approvals per account')
      }
      const snapshot = createSendSnapshot({
        path: draft.path,
        accountId: draft.accountId,
        sendAsAddress: draft.sendAsAddress,
        ...(draft.reply ? { reply: draft.reply } : {}),
        to: [...draft.to],
        cc: [...draft.cc],
        bcc: [...draft.bcc],
        subject: draft.subject,
        bodyMarkdown: draft.bodyMarkdown,
        attachments: draft.attachments.map((attachment) => ({ ...attachment })),
      })
      const id = randomUUID()
      const digest = sendSnapshotDigest(snapshot)
      const now = this.#now()
      this.#db.prepare(`
        INSERT INTO mail_outbox (
          id,draft_id,draft_revision,account_id,send_as_address,reply_rfc822_message_id,reply_source_id,
          to_json,cc_json,bcc_json,subject,body_markdown,attachments_json,message_id,content_digest,
          status,created_ms,updated_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_approval',?,?)
      `).run(
        id, draft.id, draft.revision, snapshot.accountId, snapshot.sendAsAddress,
        snapshot.reply?.rfc822MessageId ?? null, snapshot.reply?.sourceId ?? null,
        JSON.stringify(snapshot.to), JSON.stringify(snapshot.cc), JSON.stringify(snapshot.bcc),
        snapshot.subject, snapshot.bodyMarkdown, JSON.stringify(snapshot.attachments), snapshot.messageId,
        digest, now, now,
      )
      this.#insertAttention('approval_required', snapshot.accountId, id, `Approve: ${snapshot.subject}`, draft.path, now)
      return this.getOutbox(id)!
    })
  }

  issueApprovalCapability(outboxId: string, ttlMs = DEFAULT_APPROVAL_TTL_MS): string {
    const token = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest('hex')
    const now = this.#now()
    const expires = this.#deadline(now, ttlMs, 'approval TTL')
    const result = this.#db.prepare(`
      UPDATE mail_outbox SET approval_cap_hash=?,approval_expires_ms=?,updated_ms=?
      WHERE id=? AND status='pending_approval'
    `).run(hash, expires, now, outboxId)
    if (result.changes !== 1) fail('invalid_transition', 'outbox is not pending approval')
    return token
  }

  approve(outboxId: string, token: string): OutboxRecord {
    return this.#transaction(() => {
      const row = this.#requireOutbox(outboxId, 'pending_approval')
      this.#assertIdentity(snapshotFromRow(row))
      const now = this.#now()
      const approvalExpiresAt = row.approval_expires_ms
      if (!Number.isSafeInteger(approvalExpiresAt) || approvalExpiresAt == null || approvalExpiresAt <= now) {
        fail('approval_expired', 'approval capability expired or malformed')
      }
      if (!row.approval_cap_hash) fail('approval_invalid', 'approval capability was not issued')
      const actual = createHash('sha256').update(token).digest()
      const expected = Buffer.from(row.approval_cap_hash, 'hex')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        fail('approval_invalid', 'approval capability invalid')
      }
      this.#assertDigest(row)
      this.#db.prepare(`
        UPDATE mail_outbox SET status='approved',approval_cap_hash=NULL,approval_expires_ms=NULL,
          approval_consumed_ms=?,updated_ms=? WHERE id=?
      `).run(now, now, outboxId)
      this.#resolveAttentionForOutbox(outboxId, 'approval_required', now)
      return this.getOutbox(outboxId)!
    })
  }

  reject(outboxId: string): OutboxRecord {
    return this.#transaction(() => {
      this.#requireOutbox(outboxId, 'pending_approval')
      const now = this.#now()
      this.#db.prepare(`
        UPDATE mail_outbox SET status='rejected',approval_cap_hash=NULL,approval_expires_ms=NULL,
          updated_ms=? WHERE id=?
      `).run(now, outboxId)
      this.#resolveAttentionForOutbox(outboxId, 'approval_required', now)
      return this.getOutbox(outboxId)!
    })
  }

  claim(outboxId: string, workerId: string, leaseMs = DEFAULT_LEASE_MS): ClaimedSend {
    if (!workerId.trim()) fail('invalid_input', 'worker id is required')
    return this.#transaction(() => {
      const row = this.#getOutboxRow(outboxId)
      if (!row) fail('not_found', `outbox ${outboxId} not found`)
      const now = this.#now()
      const expiresAt = this.#deadline(now, leaseMs, 'send lease')
      const reclaimable = row.status === 'claimed' && Number.isSafeInteger(row.lease_expires_ms) &&
        row.lease_expires_ms! <= now
      if (row.status !== 'approved' && !reclaimable) {
        fail('invalid_transition', 'outbox is not approved or an expired pre-dispatch claim')
      }
      const snapshot = snapshotFromRow(row)
      this.#assertIdentity(snapshot)
      this.#assertDigest(row)
      this.#db.prepare(`
        UPDATE mail_outbox SET status='claimed',lease_owner=?,lease_expires_ms=?,updated_ms=? WHERE id=?
      `).run(workerId, expiresAt, now, outboxId)
      return {
        outboxId,
        draftId: row.draft_id,
        draftRevision: row.draft_revision,
        contentDigest: row.content_digest,
        snapshot,
        lease: { owner: workerId, expiresAt },
      }
    })
  }

  markDispatched(outboxId: string, workerId: string): OutboxRecord {
    return this.#transaction(() => {
      const row = this.#requireOutbox(outboxId, 'claimed')
      const now = this.#now()
      if (row.lease_owner !== workerId || !Number.isSafeInteger(row.lease_expires_ms) || row.lease_expires_ms! <= now) {
        fail('lease_invalid', 'send claim is not held by this worker or has expired')
      }
      const snapshot = snapshotFromRow(row)
      this.#assertIdentity(snapshot)
      this.#assertDigest(row)
      this.#db.prepare(`UPDATE mail_outbox SET status='dispatched',updated_ms=? WHERE id=?`).run(now, outboxId)
      return this.getOutbox(outboxId)!
    })
  }

  markSent(outboxId: string, providerMessageId: string): OutboxRecord {
    if (!providerMessageId.trim()) fail('invalid_input', 'provider message id is required')
    return this.#transaction(() => {
      this.#requireOutbox(outboxId, 'dispatched')
      const now = this.#now()
      this.#db.prepare(`
        UPDATE mail_outbox SET status='sent',lease_owner=NULL,lease_expires_ms=NULL,
          provider_message_id=?,updated_ms=? WHERE id=?
      `).run(providerMessageId, now, outboxId)
      return this.getOutbox(outboxId)!
    })
  }

  markUnknown(outboxId: string, detail: string): OutboxRecord {
    return this.#transaction(() => {
      const row = this.#requireOutbox(outboxId, 'dispatched')
      const now = this.#now()
      this.#db.prepare(`
        UPDATE mail_outbox SET status='unknown',lease_owner=NULL,lease_expires_ms=NULL,updated_ms=? WHERE id=?
      `).run(now, outboxId)
      this.#insertAttention('send_unknown', row.account_id, outboxId, 'Send outcome unknown', detail, now)
      return this.getOutbox(outboxId)!
    })
  }

  recoverExpired(): OutboxRecord[] {
    return this.#transaction(() => {
      const now = this.#now()
      const expired = this.#db.prepare(`
        SELECT * FROM mail_outbox WHERE status='dispatched' AND lease_expires_ms <= ?
      `).all(now) as unknown as OutboxRow[]
      for (const row of expired) {
        this.#db.prepare(`
          UPDATE mail_outbox SET status='unknown',lease_owner=NULL,lease_expires_ms=NULL,updated_ms=?
          WHERE id=? AND status='dispatched'
        `).run(now, row.id)
        this.#insertAttention(
          'send_unknown', row.account_id, row.id, 'Send outcome unknown',
          'worker lease expired after dispatch; reconciliation required', now,
        )
      }
      return expired.map((row) => this.getOutbox(row.id)!)
    })
  }

  reconcileUnknownAsSent(outboxId: string, providerMessageId: string): OutboxRecord {
    if (!providerMessageId.trim()) fail('invalid_input', 'provider message id is required')
    return this.#transaction(() => {
      this.#requireOutbox(outboxId, 'unknown')
      const now = this.#now()
      this.#db.prepare(`
        UPDATE mail_outbox SET status='sent',provider_message_id=?,updated_ms=? WHERE id=?
      `).run(providerMessageId, now, outboxId)
      this.#resolveAttentionForOutbox(outboxId, 'send_unknown', now)
      return this.getOutbox(outboxId)!
    })
  }

  getOutbox(id: string): OutboxRecord | null {
    const row = this.#getOutboxRow(id)
    return row ? this.#outboxFromRow(row) : null
  }

  listAttention(openOnly = true): AttentionItem[] {
    const rows = this.#db.prepare(`
      SELECT * FROM mail_attention ${openOnly ? 'WHERE resolved_ms IS NULL' : ''}
      ORDER BY created_ms ASC,id ASC
    `).all() as unknown as AttentionRow[]
    return rows.map((row) => this.#attentionFromRow(row))
  }

  resolveAttention(id: string): AttentionItem {
    const now = this.#now()
    const result = this.#db.prepare(`
      UPDATE mail_attention SET resolved_ms=? WHERE id=? AND resolved_ms IS NULL
    `).run(now, id)
    if (result.changes !== 1) fail('not_found', 'open attention item not found')
    const row = this.#db.prepare(`SELECT * FROM mail_attention WHERE id=?`).get(id) as unknown as AttentionRow
    return this.#attentionFromRow(row)
  }

  #getOutboxRow(id: string): OutboxRow | undefined {
    return this.#db.prepare(`SELECT * FROM mail_outbox WHERE id=?`).get(id) as OutboxRow | undefined
  }

  #requireOutbox(id: string, expected: OutboxStatus): OutboxRow {
    const row = this.#getOutboxRow(id)
    if (!row) fail('not_found', `outbox ${id} not found`)
    if (row.status !== expected) fail('invalid_transition', `outbox must be ${expected}; found ${row.status}`)
    return row
  }

  #assertDigest(row: OutboxRow): void {
    if (sendSnapshotDigest(snapshotFromRow(row)) !== row.content_digest) {
      fail('content_changed', 'send snapshot content digest mismatch')
    }
  }

  #outboxFromRow(row: OutboxRow): OutboxRecord {
    return {
      id: row.id,
      draftId: row.draft_id,
      draftRevision: row.draft_revision,
      status: row.status,
      snapshot: snapshotFromRow(row),
      contentDigest: row.content_digest,
      approvalExpiresAt: row.approval_expires_ms,
      approvalConsumedAt: row.approval_consumed_ms,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_ms,
      providerMessageId: row.provider_message_id,
    }
  }

  #insertAttention(
    kind: AttentionItem['kind'], accountId: string, outboxId: string,
    title: string, detail: string, now: number,
  ): void {
    this.#db.prepare(`
      INSERT INTO mail_attention (id,kind,account_id,outbox_id,title,detail,created_ms)
      VALUES (?,?,?,?,?,?,?)
    `).run(randomUUID(), kind, accountId, outboxId, title, detail, now)
  }

  #resolveAttentionForOutbox(outboxId: string, kind: AttentionItem['kind'], now: number): void {
    this.#db.prepare(`
      UPDATE mail_attention SET resolved_ms=? WHERE outbox_id=? AND kind=? AND resolved_ms IS NULL
    `).run(now, outboxId, kind)
  }

  #attentionFromRow(row: AttentionRow): AttentionItem {
    return {
      id: row.id,
      kind: row.kind,
      accountId: row.account_id,
      outboxId: row.outbox_id,
      title: row.title,
      detail: row.detail,
      createdAt: row.created_ms,
      resolvedAt: row.resolved_ms,
    }
  }
}

export function openProductStore(path: string, deps: ProductStoreDependencies): ProductStore {
  return ProductStore.open(path, deps)
}
