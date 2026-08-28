import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { decodeDraft, type DraftRow } from './codec.js'
import { StoreContext, fail } from './context.js'
import { migrateProductDatabase } from './migrations.js'
import { OutboxMachine } from './OutboxMachine.js'
import { assertValidSendContent, draftContentDigest, normalizeDraftFields, resolvedReply } from './sendSnapshot.js'
import {
  ProductStoreError,
  type AccountInput,
  type ConnectedInboxSource,
  type MsgvaultReadSourceInput,
  type ReadSourceReconcileResult,
  type DraftInput,
  type DraftRecord,
  type ProductStoreDependencies,
  type SendContent,
} from './types.js'

/** @internal Synchronous worker-owned implementation; never expose to host runtime callers. */
export class ProductStore {
  readonly outbox: OutboxMachine
  readonly #c: StoreContext
  private constructor(db: DatabaseSync, deps: ProductStoreDependencies) {
    this.#c = new StoreContext(db, deps)
    this.outbox = new OutboxMachine(this.#c)
  }
  static open(path: string, deps: ProductStoreDependencies): ProductStore {
    if (!deps || typeof deps.now !== 'function' || typeof deps.resolveReplyTarget !== 'function')
      fail('invalid_input', 'clock and trusted reply resolver are required')
    const db = new DatabaseSync(path)
    try {
      migrateProductDatabase(db)
      return new ProductStore(db, deps)
    } catch (error) {
      db.close()
      throw error
    }
  }
  close(): void {
    this.#c.db.close()
  }
  connectedInboxSources(): ConnectedInboxSource[] {
    const rows = this.#c.db.prepare(
      `SELECT source_id,identities_json FROM mail_read_sources
        WHERE enabled=1 AND present=1 ORDER BY source_id`,
    ).all() as Array<Record<string, unknown>>
    return rows.map((row) => {
      if (!Number.isSafeInteger(row.source_id) || Number(row.source_id) <= 0) {
        throw new ProductStoreError('corrupt_data', 'read source id must be a positive integer')
      }
      if (typeof row.identities_json !== 'string') {
        throw new ProductStoreError('corrupt_data', 'read-source identities must be JSON text')
      }
      let parsed: unknown
      try { parsed = JSON.parse(row.identities_json) }
      catch { throw new ProductStoreError('corrupt_data', 'read-source identities contain malformed JSON') }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new ProductStoreError('corrupt_data', 'read-source identities must be a non-empty array')
      }
      const identities = decodeNormalizedIdentitySet(parsed, 'read-source identities')
      return { sourceId: row.source_id as number, identities }
    })
  }
  setReadSourceEnabled(sourceId: number, enabled: boolean): void {
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) fail('invalid_input', 'read source id must be a positive safe integer')
    if (typeof enabled !== 'boolean') fail('invalid_input', 'read source enabled must be boolean')
    const now = this.#c.now()
    const result = this.#c.db.prepare(
      `UPDATE mail_read_sources SET enabled=?,reconciled_ms=? WHERE source_id=?`,
    ).run(enabled ? 1 : 0, now, sourceId)
    if (result.changes !== 1) throw new ProductStoreError('not_found', 'read source not found')
  }
  reconcileMsgvaultReadSources(input: MsgvaultReadSourceInput[]): ReadSourceReconcileResult {
    if (!Array.isArray(input)) fail('invalid_input', 'msgvault read sources are required')
    const normalized = normalizeReadSourceInputs(input)
    const now = this.#c.now()
    return this.#c.transaction(() => {
      let inserted = 0
      let updated = 0
      const seen = new Set<number>()
      for (const source of normalized) {
        seen.add(source.sourceId)
        const existing = this.#c.db.prepare(
          `SELECT source_id FROM mail_read_sources WHERE source_id=?`,
        ).get(source.sourceId) as { source_id: number } | undefined
        if (existing) updated++
        else inserted++
        this.#c.db.prepare(
          `INSERT INTO mail_read_sources(source_id,exact_identifier,identities_json,enabled,present,reconciled_ms)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(source_id) DO UPDATE SET
             exact_identifier=excluded.exact_identifier,
             identities_json=excluded.identities_json,
             present=1,
             reconciled_ms=excluded.reconciled_ms`,
        ).run(
          source.sourceId,
          source.exactIdentifier,
          JSON.stringify(source.identities),
          1,
          1,
          now,
        )
      }
      const rows = this.#c.db.prepare(`SELECT source_id FROM mail_read_sources WHERE present=1`).all() as Array<{ source_id: unknown }>
      let vanished = 0
      for (const row of rows) {
        if (!Number.isSafeInteger(row.source_id) || Number(row.source_id) <= 0) {
          throw new ProductStoreError('corrupt_data', 'read source id must be a positive integer')
        }
        const sourceId = row.source_id as number
        if (!seen.has(sourceId)) {
          const result = this.#c.db.prepare(
            `UPDATE mail_read_sources SET present=0,reconciled_ms=? WHERE source_id=?`,
          ).run(now, sourceId)
          vanished += Number(result.changes ?? 0)
        }
      }
      return { inserted, updated, vanished, generation: this.readSourceGeneration() }
    })
  }
  private readSourceGeneration(): string {
    const rows = this.#c.db.prepare(
      `SELECT source_id,identities_json,enabled,present FROM mail_read_sources ORDER BY source_id`,
    ).all() as Array<Record<string, unknown>>
    return JSON.stringify(rows)
  }
  upsertAccount(input: AccountInput): void {
    const id = input.accountId.trim(),
      primary = input.primaryAddress.trim().toLowerCase()
    if (!id || !primary || !Number.isSafeInteger(input.providerSourceId) || input.providerSourceId <= 0)
      fail('invalid_input', 'account id, primary address and integer source are required')
    const sendAs = [...new Set(input.sendAs.map((x) => x.trim().toLowerCase()).filter(Boolean))]
    if (!sendAs.includes(primary)) sendAs.unshift(primary)
    const now = this.#c.now()
    this.#c.db
      .prepare(
        `INSERT INTO mail_accounts(account_id,provider_source_id,primary_address,send_as_json,connected,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET provider_source_id=excluded.provider_source_id,primary_address=excluded.primary_address,send_as_json=excluded.send_as_json,connected=excluded.connected,updated_ms=excluded.updated_ms`,
      )
      .run(
        id,
        input.providerSourceId,
        primary,
        JSON.stringify(sendAs),
        input.connected === false ? 0 : 1,
        now,
        now,
      )
  }
  saveDraft(input: DraftInput, requestedId: string = randomUUID()): DraftRecord {
    const fields = normalizeDraftFields(input)
    let accountId: string, reply: SendContent['reply']
    if (input.kind === 'compose') {
      accountId = input.accountId.trim()
      if (!accountId) fail('invalid_input', 'account id is required')
    } else {
      if (!Number.isSafeInteger(input.replyToMessageId) || input.replyToMessageId <= 0)
        fail('invalid_input', 'reply message id must be a safe integer')
      const target = this.#c.deps.resolveReplyTarget(input.replyToMessageId)
      if (!target)
        throw new ProductStoreError('identity_revoked', 'reply message is absent from trusted msgvault state')
      const account = this.#c.db
        .prepare(`SELECT account_id FROM mail_accounts WHERE provider_source_id=?`)
        .get(target.sourceId) as { account_id: string } | undefined
      if (!account)
        throw new ProductStoreError('identity_revoked', 'no connected product account owns the reply source')
      accountId = account.account_id
      reply = resolvedReply(input.replyToMessageId, target)
    }
    const content: SendContent = {
      accountId,
      sendAsAddress: fields.sendAsAddress,
      ...(reply ? { reply } : {}),
      to: fields.to,
      cc: fields.cc,
      bcc: fields.bcc,
      subject: fields.subject,
      bodyMarkdown: fields.bodyMarkdown,
      attachments: fields.attachments,
    }
    assertValidSendContent(content)
    this.#c.assertIdentity(content)
    const digest = draftContentDigest(content)
    return this.#c.transaction(() => {
      const existing = this.#c.db
        .prepare(`SELECT * FROM mail_drafts WHERE path=?`)
        .get(fields.path) as unknown as DraftRow | undefined
      if (existing) {
        const decoded = decodeDraft(existing)
        if (decoded.contentDigest === digest) return decoded
        const now = this.#c.now()
        this.#c.db
          .prepare(
            `UPDATE mail_outbox SET status='stale',approval_cap_hash=NULL,approval_session_hash=NULL,approval_expires_ms=NULL,lease_owner=NULL,lease_expires_ms=NULL,updated_ms=? WHERE draft_id=? AND status IN('pending_approval','approved','claimed')`,
          )
          .run(now, decoded.id)
        this.#c.db
          .prepare(
            `UPDATE mail_attention SET resolved_ms=? WHERE kind='approval_required' AND resolved_ms IS NULL AND outbox_id IN(SELECT id FROM mail_outbox WHERE draft_id=? AND status='stale')`,
          )
          .run(now, decoded.id)
        this.writeDraft(decoded.id, decoded.revision + 1, fields.path, content, digest, decoded.id, now)
        return this.getDraft(decoded.id)!
      }
      const now = this.#c.now()
      this.writeDraft(requestedId, 1, fields.path, content, digest, null, now)
      return this.getDraft(requestedId)!
    })
  }
  private writeDraft(
    id: string,
    revision: number,
    path: string,
    c: SendContent,
    digest: string,
    existing: string | null,
    now: number,
  ): void {
    const values = [
      revision,
      c.accountId,
      c.sendAsAddress,
      c.reply?.messageId ?? null,
      c.reply?.rfc822MessageId ?? null,
      c.reply?.sourceId ?? null,
      JSON.stringify(c.to),
      JSON.stringify(c.cc),
      JSON.stringify(c.bcc),
      c.subject,
      c.bodyMarkdown,
      JSON.stringify(c.attachments),
      digest,
      now,
    ]
    if (existing) {
      this.#c.db
        .prepare(
          `UPDATE mail_drafts SET revision=?,account_id=?,send_as_address=?,reply_message_id=?,reply_rfc822_message_id=?,reply_source_id=?,to_json=?,cc_json=?,bcc_json=?,subject=?,body_markdown=?,attachments_json=?,content_digest=?,updated_ms=? WHERE id=?`,
        )
        .run(...values, existing)
    } else {
      this.#c.db
        .prepare(
          `INSERT INTO mail_drafts(id,path,revision,account_id,send_as_address,reply_message_id,reply_rfc822_message_id,reply_source_id,to_json,cc_json,bcc_json,subject,body_markdown,attachments_json,content_digest,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, path, ...values.slice(0, -1), now, now)
    }
  }
  getDraft(id: string): DraftRecord | null {
    const row = this.#c.db.prepare(`SELECT * FROM mail_drafts WHERE id=?`).get(id) as unknown as
      | DraftRow
      | undefined
    return row ? decodeDraft(row) : null
  }
}
export const openProductStore = (path: string, deps: ProductStoreDependencies): ProductStore =>
  ProductStore.open(path, deps)

function validMailIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 320 &&
    !/[\s\x00-\x1F\x7F]/u.test(value) &&
    value.indexOf('@') > 0 && value.indexOf('@') === value.lastIndexOf('@') && !value.endsWith('@')
}

function decodeNormalizedIdentitySet(values: unknown[], name: string): string[] {
  const identities = values.map((identity) => {
    if (typeof identity !== 'string') throw new ProductStoreError('corrupt_data', `${name} must contain text`)
    const normalized = identity.trim().toLowerCase()
    if (identity !== normalized || !validMailIdentity(normalized)) {
      throw new ProductStoreError('corrupt_data', `${name} must contain normalized email identities`)
    }
    return normalized
  })
  const unique = [...new Set(identities)]
  if (unique.length !== identities.length || unique.length === 0) {
    throw new ProductStoreError('corrupt_data', `${name} must be unique and non-empty`)
  }
  return unique
}

function normalizeReadSourceInputs(input: MsgvaultReadSourceInput[]): MsgvaultReadSourceInput[] {
  const sourceIds = new Set<number>()
  const identityOwners = new Map<string, number>()
  return input.map((source) => {
    if (!source || !Number.isSafeInteger(source.sourceId) || source.sourceId <= 0 || sourceIds.has(source.sourceId)) {
      throw new ProductStoreError('corrupt_data', 'msgvault read source ids must be unique positive safe integers')
    }
    sourceIds.add(source.sourceId)
    if (typeof source.exactIdentifier !== 'string' || !source.exactIdentifier || source.exactIdentifier !== source.exactIdentifier.trim() ||
        !validMailIdentity(source.exactIdentifier)) {
      throw new ProductStoreError('corrupt_data', 'msgvault source identifier is invalid')
    }
    if (!Array.isArray(source.identities)) {
      throw new ProductStoreError('corrupt_data', 'msgvault identities must be an array')
    }
    const identities = [...new Set([source.exactIdentifier, ...source.identities].map((identity) => {
      if (typeof identity !== 'string') throw new ProductStoreError('corrupt_data', 'msgvault identities must be text')
      const normalized = identity.trim().toLowerCase()
      if (!validMailIdentity(normalized)) throw new ProductStoreError('corrupt_data', 'msgvault identities must be email-like')
      return normalized
    }))].sort()
    for (const identity of identities) {
      const owner = identityOwners.get(identity)
      if (owner !== undefined && owner !== source.sourceId) {
        throw new ProductStoreError('corrupt_data', 'msgvault identity/source collision detected')
      }
      identityOwners.set(identity, source.sourceId)
    }
    return { sourceId: source.sourceId, exactIdentifier: source.exactIdentifier, identities }
  }).sort((left, right) => left.sourceId - right.sourceId)
}
