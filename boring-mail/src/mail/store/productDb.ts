// bm-8ae — boring-mail product state (separate from msgvault's archive DB).
// Owns drafts, approval-bound outbox snapshots and attention items. It NEVER
// copies provider message bodies: provider joins are rfc822_message_id+source_id.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { posix } from 'node:path'

export type OutboxStatus =
  | 'pending_approval'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'unknown'
  | 'rejected'
  | 'stale'

export interface MailAttachmentInput {
  name: string
  mimeType: string
  contentHash: string
  size: number
}

export interface DraftInput {
  path: string
  accountId: string
  sendAsAddress: string
  replyRfc822MessageId?: string
  replySourceId?: number
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyMarkdown: string
  attachments?: MailAttachmentInput[]
}

export interface DraftRecord extends DraftInput {
  id: string
  revision: number
  contentDigest: string
}

export interface OutboxRecord {
  id: string
  draftId: string
  draftRevision: number
  accountId: string
  contentDigest: string
  idempotencyKey: string
  status: OutboxStatus
  approvalExpiresAt: string | null
  approvalConsumedAt: string | null
  sendAttemptCount: number
  providerMessageId: string | null
}

export interface ProductDbOptions {
  /** Trusted msgvault lookup. Required for reply drafts. */
  verifyReplyOwnership?: (rfc822MessageId: string, sourceId: number) => boolean
}

export interface ProductDb {
  db: DatabaseSync
  close(): void
}

const optionsByDb = new WeakMap<DatabaseSync, ProductDbOptions>()

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mail_accounts (
  account_id TEXT PRIMARY KEY,
  provider_source_id INTEGER NOT NULL UNIQUE,
  primary_address TEXT NOT NULL,
  send_as_json TEXT NOT NULL,
  connected INTEGER NOT NULL DEFAULT 1 CHECK (connected IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),
  send_as_address TEXT NOT NULL,
  reply_rfc822_message_id TEXT,
  reply_source_id INTEGER,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  bcc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((reply_rfc822_message_id IS NULL) = (reply_source_id IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS mail_outbox (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES mail_drafts(id),
  draft_revision INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),
  send_as_address TEXT NOT NULL,
  reply_rfc822_message_id TEXT,
  reply_source_id INTEGER,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  bcc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','sending','sent','unknown','rejected','stale')),
  approval_cap_hash TEXT,
  approval_expires_at TEXT,
  approval_consumed_at TEXT,
  send_lease_owner TEXT,
  send_lease_until TEXT,
  send_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (send_attempt_count BETWEEN 0 AND 1),
  provider_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, idempotency_key),
  CHECK ((reply_rfc822_message_id IS NULL) = (reply_source_id IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, account_id);

CREATE TABLE IF NOT EXISTS mail_attention (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('approval_required','send_unknown','account_error')),
  account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),
  outbox_id TEXT REFERENCES mail_outbox(id),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX IF NOT EXISTS idx_mail_attention_open ON mail_attention(resolved_at, created_at);
`

export function openProductDb(path: string, options: ProductDbOptions = {}): ProductDb {
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  optionsByDb.set(db, options)
  return { db, close: () => db.close() }
}

function tx<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function jsonArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(parsed) ? parsed.map(String) : []
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeDraftPath(path: string): string {
  const slash = path.replace(/\\/g, '/')
  if (slash.startsWith('/') || slash.split('/').includes('..')) throw new Error('draft path must be workspace-relative and may not escape')
  const normalized = posix.normalize(slash).replace(/^\.\//, '')
  if (!normalized.endsWith('.mail.md')) throw new Error('draft path must end with .mail.md')
  return normalized
}

function normalizeInput(input: DraftInput): DraftInput {
  const replyId = input.replyRfc822MessageId?.trim() || undefined
  if ((replyId == null) !== (input.replySourceId == null)) {
    throw new Error('replyRfc822MessageId and replySourceId must be supplied together')
  }
  if (input.to.length === 0) throw new Error('at least one To recipient is required')
  return {
    path: normalizeDraftPath(input.path),
    accountId: input.accountId,
    sendAsAddress: normalizeAddress(input.sendAsAddress),
    ...(replyId ? { replyRfc822MessageId: replyId, replySourceId: input.replySourceId } : {}),
    to: input.to.map(normalizeAddress),
    cc: (input.cc ?? []).map(normalizeAddress),
    bcc: (input.bcc ?? []).map(normalizeAddress),
    subject: input.subject,
    bodyMarkdown: input.bodyMarkdown,
    attachments: (input.attachments ?? []).map((a) => ({ ...a })),
  }
}

/** Stable object-key order, array order preserved (attachment/recipient order is covered). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`
}

function sendContent(input: DraftInput): Omit<DraftInput, 'path'> {
  const { path: _registryPath, ...covered } = normalizeInput(input)
  return covered
}

export function computeContentDigest(input: DraftInput): string {
  // Registry path is not wire content and intentionally excluded. Everything
  // capable of changing recipient, identity or bytes-on-wire remains covered.
  return createHash('sha256').update(canonical(sendContent(input))).digest('hex')
}

export function upsertAccount(
  db: DatabaseSync,
  account: { accountId: string; providerSourceId: number; primaryAddress: string; sendAs: string[]; connected?: boolean },
): void {
  const primary = normalizeAddress(account.primaryAddress)
  const sendAs = [...new Set(account.sendAs.map(normalizeAddress))]
  if (!sendAs.includes(primary)) sendAs.unshift(primary)
  db.prepare(`
    INSERT INTO mail_accounts (account_id, provider_source_id, primary_address, send_as_json, connected)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      provider_source_id=excluded.provider_source_id,
      primary_address=excluded.primary_address,
      send_as_json=excluded.send_as_json,
      connected=excluded.connected,
      updated_at=CURRENT_TIMESTAMP
  `).run(account.accountId, account.providerSourceId, primary, JSON.stringify(sendAs), account.connected === false ? 0 : 1)
}

function assertAuthorizedIdentity(db: DatabaseSync, accountId: string, sendAsAddress: string): void {
  const row = db.prepare(
    `SELECT send_as_json, connected FROM mail_accounts WHERE account_id = ?`,
  ).get(accountId) as { send_as_json: string; connected: number } | undefined
  if (!row || row.connected !== 1) throw new Error(`account ${accountId} is disconnected or unknown`)
  const allowed = jsonArray(row.send_as_json).map(normalizeAddress)
  if (!allowed.includes(normalizeAddress(sendAsAddress))) {
    throw new Error(`send-as identity ${sendAsAddress} is not provider-authorised for account ${accountId}`)
  }
}

function rowToDraft(row: Record<string, unknown>): DraftRecord {
  return {
    id: String(row.id),
    path: String(row.path),
    revision: Number(row.revision),
    accountId: String(row.account_id),
    sendAsAddress: String(row.send_as_address),
    ...(row.reply_rfc822_message_id ? {
      replyRfc822MessageId: String(row.reply_rfc822_message_id),
      replySourceId: Number(row.reply_source_id),
    } : {}),
    to: jsonArray(row.to_json),
    cc: jsonArray(row.cc_json),
    bcc: jsonArray(row.bcc_json),
    subject: String(row.subject),
    bodyMarkdown: String(row.body_markdown),
    attachments: JSON.parse(String(row.attachments_json)) as MailAttachmentInput[],
    contentDigest: String(row.content_digest),
  }
}

export function saveDraft(db: DatabaseSync, input: DraftInput, id = randomUUID()): DraftRecord {
  const value = normalizeInput(input)
  assertAuthorizedIdentity(db, value.accountId, value.sendAsAddress)
  if (value.replySourceId != null && value.replyRfc822MessageId) {
    const owner = db.prepare(`SELECT provider_source_id FROM mail_accounts WHERE account_id=?`)
      .get(value.accountId) as { provider_source_id: number } | undefined
    const verify = optionsByDb.get(db)?.verifyReplyOwnership
    if (!owner || owner.provider_source_id !== value.replySourceId || !verify ||
        !verify(value.replyRfc822MessageId, value.replySourceId)) {
      throw new Error('reply account must be derived from trusted msgvault state; client-selected ownership refused')
    }
  }
  const digest = computeContentDigest(value)
  return tx(db, () => {
    const existing = db.prepare(`SELECT id, revision FROM mail_drafts WHERE path = ?`).get(value.path) as
      | { id: string; revision: number }
      | undefined
    const draftId = existing?.id ?? id
    const revision = (existing?.revision ?? 0) + 1
    if (existing) {
      db.prepare(`
        UPDATE mail_outbox SET status='stale', approval_cap_hash=NULL, approval_expires_at=NULL,
          send_lease_owner=NULL, send_lease_until=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE draft_id=? AND (
          status IN ('pending_approval','approved') OR (status='sending' AND send_attempt_count=0)
        )
      `).run(draftId)
      db.prepare(`
        UPDATE mail_attention SET resolved_at=CURRENT_TIMESTAMP
        WHERE outbox_id IN (SELECT id FROM mail_outbox WHERE draft_id=? AND status='stale')
          AND kind='approval_required' AND resolved_at IS NULL
      `).run(draftId)
      db.prepare(`
        UPDATE mail_drafts SET revision=?, account_id=?, send_as_address=?,
          reply_rfc822_message_id=?, reply_source_id=?, to_json=?, cc_json=?, bcc_json=?,
          subject=?, body_markdown=?, attachments_json=?, content_digest=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        revision, value.accountId, value.sendAsAddress, value.replyRfc822MessageId ?? null,
        value.replySourceId ?? null, JSON.stringify(value.to), JSON.stringify(value.cc),
        JSON.stringify(value.bcc), value.subject, value.bodyMarkdown, JSON.stringify(value.attachments),
        digest, draftId,
      )
    } else {
      db.prepare(`
        INSERT INTO mail_drafts (id,path,revision,account_id,send_as_address,
          reply_rfc822_message_id,reply_source_id,to_json,cc_json,bcc_json,subject,
          body_markdown,attachments_json,content_digest)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        draftId, value.path, revision, value.accountId, value.sendAsAddress,
        value.replyRfc822MessageId ?? null, value.replySourceId ?? null, JSON.stringify(value.to),
        JSON.stringify(value.cc), JSON.stringify(value.bcc), value.subject, value.bodyMarkdown,
        JSON.stringify(value.attachments), digest,
      )
    }
    return getDraft(db, draftId)!
  })
}

export function getDraft(db: DatabaseSync, id: string): DraftRecord | null {
  const row = db.prepare(`SELECT * FROM mail_drafts WHERE id=?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToDraft(row) : null
}

function mintIdempotencyKey(): string {
  return `<out-${randomBytes(16).toString('hex')}@boring-mail.invalid>`
}

function computeOutboxDigest(input: DraftInput, idempotencyKey: string): string {
  // Message-ID is generated before approval and is covered like every other
  // generated header. Date/RFC822 composition is added by the send-lane bead.
  return createHash('sha256')
    .update(canonical({ content: sendContent(input), messageId: idempotencyKey }))
    .digest('hex')
}

export function enqueueForApproval(db: DatabaseSync, draftId: string): OutboxRecord {
  return tx(db, () => {
    const draft = getDraft(db, draftId)
    if (!draft) throw new Error(`draft ${draftId} not found`)
    assertAuthorizedIdentity(db, draft.accountId, draft.sendAsAddress)
    const pending = db.prepare(
      `SELECT COUNT(*) AS count FROM mail_outbox WHERE account_id=? AND status='pending_approval'`,
    ).get(draft.accountId) as { count: number }
    if (pending.count >= 5) throw new Error('approval_backlog: maximum 5 pending approvals per account')
    const id = randomUUID()
    const idempotencyKey = mintIdempotencyKey()
    const approvalDigest = computeOutboxDigest(draft, idempotencyKey)
    db.prepare(`
      INSERT INTO mail_outbox (id,draft_id,draft_revision,account_id,send_as_address,
        reply_rfc822_message_id,reply_source_id,to_json,cc_json,bcc_json,subject,
        body_markdown,attachments_json,content_digest,idempotency_key,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_approval')
    `).run(
      id, draft.id, draft.revision, draft.accountId, draft.sendAsAddress,
      draft.replyRfc822MessageId ?? null, draft.replySourceId ?? null, JSON.stringify(draft.to),
      JSON.stringify(draft.cc), JSON.stringify(draft.bcc), draft.subject, draft.bodyMarkdown,
      JSON.stringify(draft.attachments), approvalDigest, idempotencyKey,
    )
    db.prepare(`INSERT INTO mail_attention (id,kind,account_id,outbox_id,title,detail) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), 'approval_required', draft.accountId, id, `Approve: ${draft.subject}`, draft.path)
    return getOutbox(db, id)!
  })
}

function rowToOutbox(row: Record<string, unknown>): OutboxRecord {
  return {
    id: String(row.id),
    draftId: String(row.draft_id),
    draftRevision: Number(row.draft_revision),
    accountId: String(row.account_id),
    contentDigest: String(row.content_digest),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as OutboxStatus,
    approvalExpiresAt: row.approval_expires_at ? String(row.approval_expires_at) : null,
    approvalConsumedAt: row.approval_consumed_at ? String(row.approval_consumed_at) : null,
    sendAttemptCount: Number(row.send_attempt_count),
    providerMessageId: row.provider_message_id ? String(row.provider_message_id) : null,
  }
}

export function getOutbox(db: DatabaseSync, id: string): OutboxRecord | null {
  const row = db.prepare(`SELECT * FROM mail_outbox WHERE id=?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToOutbox(row) : null
}

export function issueApprovalCapability(
  db: DatabaseSync,
  outboxId: string,
  ttlMs = 5 * 60_000,
): string {
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const expires = new Date(Date.now() + ttlMs).toISOString()
  const result = db.prepare(`
    UPDATE mail_outbox SET approval_cap_hash=?, approval_expires_at=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending_approval'
  `).run(hash, expires, outboxId)
  if (result.changes !== 1) throw new Error('outbox is not pending approval')
  return token
}

function assertOutboxIdentity(db: DatabaseSync, row: Record<string, unknown>): void {
  const accountId = String(row.account_id)
  const sendAs = String(row.send_as_address)
  assertAuthorizedIdentity(db, accountId, sendAs)
  if (row.reply_source_id != null && row.reply_rfc822_message_id) {
    const account = db.prepare(`SELECT provider_source_id FROM mail_accounts WHERE account_id=?`)
      .get(accountId) as { provider_source_id: number } | undefined
    const sourceId = Number(row.reply_source_id)
    const verify = optionsByDb.get(db)?.verifyReplyOwnership
    if (!account || account.provider_source_id !== sourceId || !verify ||
        !verify(String(row.reply_rfc822_message_id), sourceId)) {
      throw new Error('reply ownership or sending identity was revoked')
    }
  }
}

function outboxDigest(row: Record<string, unknown>): string {
  const input: DraftInput = {
    path: String(row.path ?? `${row.draft_id}.mail.md`),
    accountId: String(row.account_id),
    sendAsAddress: String(row.send_as_address),
    ...(row.reply_rfc822_message_id ? {
      replyRfc822MessageId: String(row.reply_rfc822_message_id),
      replySourceId: Number(row.reply_source_id),
    } : {}),
    to: jsonArray(row.to_json),
    cc: jsonArray(row.cc_json),
    bcc: jsonArray(row.bcc_json),
    subject: String(row.subject),
    bodyMarkdown: String(row.body_markdown),
    attachments: JSON.parse(String(row.attachments_json)) as MailAttachmentInput[],
  }
  return computeOutboxDigest(input, String(row.idempotency_key))
}

export function approveOutbox(db: DatabaseSync, outboxId: string, token: string): OutboxRecord {
  return tx(db, () => {
    const row = db.prepare(`
      SELECT o.*, d.path FROM mail_outbox o JOIN mail_drafts d ON d.id=o.draft_id WHERE o.id=?
    `).get(outboxId) as Record<string, unknown> | undefined
    if (!row || row.status !== 'pending_approval') throw new Error('outbox is not pending approval')
    assertOutboxIdentity(db, row)
    if (!row.approval_cap_hash || !row.approval_expires_at) throw new Error('approval capability was not issued')
    if (Date.parse(String(row.approval_expires_at)) <= Date.now()) throw new Error('approval capability expired')
    const actual = createHash('sha256').update(token).digest()
    const expected = Buffer.from(String(row.approval_cap_hash), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('approval capability invalid')
    }
    if (outboxDigest(row) !== row.content_digest) throw new Error('content digest mismatch; approval invalidated')
    db.prepare(`
      UPDATE mail_outbox SET status='approved', approval_cap_hash=NULL,
        approval_consumed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(outboxId)
    db.prepare(`UPDATE mail_attention SET resolved_at=CURRENT_TIMESTAMP WHERE outbox_id=? AND kind='approval_required'`).run(outboxId)
    return getOutbox(db, outboxId)!
  })
}

export function claimApprovedOutbox(
  db: DatabaseSync,
  outboxId: string,
  workerId: string,
  leaseMs = 60_000,
): OutboxRecord {
  return tx(db, () => {
    const row = db.prepare(`
      SELECT o.*, d.path FROM mail_outbox o JOIN mail_drafts d ON d.id=o.draft_id WHERE o.id=?
    `).get(outboxId) as Record<string, unknown> | undefined
    const reclaimable = row?.status === 'sending' && Number(row.send_attempt_count) === 0 &&
      Date.parse(String(row.send_lease_until)) <= Date.now()
    if (!row || (row.status !== 'approved' && !reclaimable)) throw new Error('outbox is not approved or reclaimable')
    assertOutboxIdentity(db, row)
    if (outboxDigest(row) !== row.content_digest) throw new Error('content digest mismatch before claim')
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
    db.prepare(`UPDATE mail_outbox SET status='sending',send_lease_owner=?,send_lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(workerId, leaseUntil, outboxId)
    return getOutbox(db, outboxId)!
  })
}

/** Called immediately before the irreversible provider request. */
export function markOutboxDispatched(db: DatabaseSync, outboxId: string, workerId: string): OutboxRecord {
  return tx(db, () => {
    const row = db.prepare(`
      SELECT o.*, d.path FROM mail_outbox o JOIN mail_drafts d ON d.id=o.draft_id WHERE o.id=?
    `).get(outboxId) as Record<string, unknown> | undefined
    if (!row || row.status !== 'sending' || row.send_lease_owner !== workerId ||
        Number(row.send_attempt_count) !== 0 || Date.parse(String(row.send_lease_until)) <= Date.now()) {
      throw new Error('outbox is not held by this worker or was already dispatched')
    }
    assertOutboxIdentity(db, row) // revalidate immediately before irreversible request
    if (outboxDigest(row) !== row.content_digest) throw new Error('content digest mismatch before dispatch')
    db.prepare(`UPDATE mail_outbox SET send_attempt_count=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(outboxId)
    return getOutbox(db, outboxId)!
  })
}

export function markOutboxSent(db: DatabaseSync, outboxId: string, providerMessageId: string): OutboxRecord {
  const result = db.prepare(`
    UPDATE mail_outbox SET status='sent',provider_message_id=?,send_lease_owner=NULL,
      send_lease_until=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='sending' AND send_attempt_count=1
  `).run(providerMessageId, outboxId)
  if (result.changes !== 1) throw new Error('outbox is not a dispatched send')
  return getOutbox(db, outboxId)!
}

export function markOutboxUnknown(db: DatabaseSync, outboxId: string, detail: string): OutboxRecord {
  return tx(db, () => {
    const result = db.prepare(`
      UPDATE mail_outbox SET status='unknown',send_lease_owner=NULL,send_lease_until=NULL,
        updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='sending' AND send_attempt_count=1
    `).run(outboxId)
    if (result.changes !== 1) throw new Error('outbox is not sending')
    const row = getOutbox(db, outboxId)!
    db.prepare(`INSERT INTO mail_attention (id,kind,account_id,outbox_id,title,detail) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), 'send_unknown', row.accountId, outboxId, 'Send outcome unknown', detail)
    return row
  })
}

/** Startup/reaper path: a dispatched row with an expired lease is ambiguous. */
export function recoverExpiredDispatched(db: DatabaseSync, now = new Date()): OutboxRecord[] {
  return tx(db, () => {
    const rows = db.prepare(`
      SELECT id FROM mail_outbox
      WHERE status='sending' AND send_attempt_count=1 AND send_lease_until <= ?
    `).all(now.toISOString()) as Array<{ id: string }>
    const recovered: OutboxRecord[] = []
    for (const { id } of rows) {
      db.prepare(`
        UPDATE mail_outbox SET status='unknown',send_lease_owner=NULL,send_lease_until=NULL,
          updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='sending' AND send_attempt_count=1
      `).run(id)
      const row = getOutbox(db, id)!
      const existing = db.prepare(`
        SELECT 1 FROM mail_attention WHERE outbox_id=? AND kind='send_unknown' AND resolved_at IS NULL
      `).get(id)
      if (!existing) {
        db.prepare(`INSERT INTO mail_attention (id,kind,account_id,outbox_id,title,detail) VALUES (?,?,?,?,?,?)`)
          .run(randomUUID(), 'send_unknown', row.accountId, id, 'Send outcome unknown',
            'worker lease expired after dispatch; reconciliation required')
      }
      recovered.push(row)
    }
    return recovered
  })
}

export function listOpenAttention(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM mail_attention WHERE resolved_at IS NULL ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>
}
