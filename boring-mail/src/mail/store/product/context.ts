import { DatabaseSync } from 'node:sqlite'
import { decodeOutbox, decodeStringArray, type OutboxRow } from './codec.js'
import {
  ProductStoreError,
  type OutboxRecord,
  type ProductStoreDependencies,
  type SendContent,
} from './types.js'
export function fail(code: ConstructorParameters<typeof ProductStoreError>[0], message: string): never {
  throw new ProductStoreError(code, message)
}
export class StoreContext {
  constructor(
    readonly db: DatabaseSync,
    readonly deps: ProductStoreDependencies,
  ) {}
  now(): number {
    const n = this.deps.now()
    if (!Number.isSafeInteger(n) || n < 0)
      fail('invalid_input', 'clock must return non-negative epoch milliseconds')
    return n
  }
  deadline(now: number, duration: number, name: string): number {
    if (!Number.isSafeInteger(duration) || duration <= 0)
      fail('invalid_input', `${name} must be a positive finite duration`)
    const result = now + duration
    if (!Number.isSafeInteger(result)) fail('invalid_input', `${name} deadline exceeds safe integer range`)
    return result
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  assertIdentity(content: Pick<SendContent, 'accountId' | 'sendAsAddress' | 'reply'>): void {
    const account = this.db
      .prepare(`SELECT provider_source_id,send_as_json,connected FROM mail_accounts WHERE account_id=?`)
      .get(content.accountId) as
      | { provider_source_id: unknown; send_as_json: unknown; connected: unknown }
      | undefined
    if (!account || account.connected !== 1)
      throw new ProductStoreError(
        'identity_revoked',
        `account ${content.accountId} is disconnected or unknown`,
      )
    if (!Number.isSafeInteger(account.provider_source_id) || Number(account.provider_source_id) <= 0) {
      fail('corrupt_data', 'account provider source must be a positive safe integer')
    }
    if (!decodeStringArray(account.send_as_json, 'account.send_as').includes(content.sendAsAddress))
      fail('identity_revoked', `send-as identity ${content.sendAsAddress} is not provider-authorised`)
    if (content.reply) {
      const target = this.deps.resolveReplyTarget(content.reply.messageId)
      if (
        account.provider_source_id !== content.reply.sourceId ||
        !target ||
        target.sourceId !== content.reply.sourceId ||
        target.rfc822MessageId !== content.reply.rfc822MessageId
      )
        fail('identity_revoked', 'reply ownership is not present in trusted msgvault state')
    }
  }
  row(id: string): OutboxRow | undefined {
    return this.db.prepare(`SELECT * FROM mail_outbox WHERE id=?`).get(id) as unknown as OutboxRow | undefined
  }
  outbox(id: string): OutboxRecord | null {
    const row = this.row(id)
    return row ? decodeOutbox(row) : null
  }
  require<S extends OutboxRecord['status']>(
    id: string,
    status: S,
  ): { row: OutboxRow; record: Extract<OutboxRecord, { status: S }> }
  require(id: string): { row: OutboxRow; record: OutboxRecord }
  require(id: string, status?: OutboxRecord['status']): { row: OutboxRow; record: OutboxRecord } {
    const row = this.row(id)
    if (!row) throw new ProductStoreError('not_found', `outbox ${id} not found`)
    const record = decodeOutbox(row)
    if (status && record.status !== status)
      fail('invalid_transition', `outbox must be ${status}; found ${record.status}`)
    return { row, record }
  }
}
