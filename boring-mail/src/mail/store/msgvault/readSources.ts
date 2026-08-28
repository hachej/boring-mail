import { DatabaseSync } from 'node:sqlite'
import { ProductStoreError, type MsgvaultReadSourceInput } from '../product/types.js'
import {
  readMsgvaultTableColumns,
  validateMsgvaultAccountIdentitiesSchema,
  validateMsgvaultSourcesSchema,
} from './schema.js'

function validExactGmailIdentifier(account: string): boolean {
  return account.length > 0 && account.length <= 320 && account === account.trim() &&
    !/[\s\x00-\x1F\x7F]/u.test(account) &&
    account.indexOf('@') > 0 && account.indexOf('@') === account.lastIndexOf('@') && !account.endsWith('@')
}

function normalizeIdentity(value: unknown): string {
  if (typeof value !== 'string') throw new ProductStoreError('corrupt_data', 'msgvault account identity is not text')
  const normalized = value.trim().toLowerCase()
  if (!validExactGmailIdentifier(normalized)) {
    throw new ProductStoreError('corrupt_data', 'msgvault account identity is invalid')
  }
  return normalized
}

export function readMsgvaultGmailReadSourceSnapshot(db: DatabaseSync): MsgvaultReadSourceInput[] {
  const schemaErrors = [
    ...validateMsgvaultSourcesSchema(readMsgvaultTableColumns(db, 'sources')),
    ...validateMsgvaultAccountIdentitiesSchema(readMsgvaultTableColumns(db, 'account_identities')),
  ]
  if (schemaErrors.length) {
    throw new ProductStoreError(
      'unsupported_schema',
      `msgvault read-source schema drifted: ${schemaErrors.join('; ')}`,
    )
  }
  const rows = db.prepare(
    `SELECT id,identifier FROM sources WHERE source_type='gmail' ORDER BY id`,
  ).all() as Array<{ id: unknown; identifier: unknown }>
  const seenSources = new Set<number>()
  const identityOwners = new Map<string, number>()
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || seenSources.has(row.id as number)) {
      throw new ProductStoreError('corrupt_data', 'msgvault Gmail source ids must be unique positive integers')
    }
    const sourceId = row.id as number
    seenSources.add(sourceId)
    if (typeof row.identifier !== 'string' || !validExactGmailIdentifier(row.identifier)) {
      throw new ProductStoreError('corrupt_data', 'msgvault Gmail source identifier is invalid')
    }
    const identityRows = db.prepare(
      `SELECT address FROM account_identities WHERE source_id=? ORDER BY address`,
    ).all(sourceId) as Array<{ address: unknown }>
    const identities = [...new Set([
      normalizeIdentity(row.identifier),
      ...identityRows.map((identity) => normalizeIdentity(identity.address)),
    ])].sort()
    if (identities.length === 0) {
      throw new ProductStoreError('corrupt_data', 'msgvault Gmail source has no identities')
    }
    for (const identity of identities) {
      const owner = identityOwners.get(identity)
      if (owner !== undefined && owner !== sourceId) {
        throw new ProductStoreError('corrupt_data', 'msgvault identity/source collision detected')
      }
      identityOwners.set(identity, sourceId)
    }
    return { sourceId, exactIdentifier: row.identifier, identities }
  })
}
