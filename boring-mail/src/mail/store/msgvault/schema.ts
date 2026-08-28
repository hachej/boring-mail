import { DatabaseSync } from 'node:sqlite'

export interface MsgvaultSchemaColumn {
  name: string
  type: string
  notnull: number
  dflt_value?: string | null
  pk: number
}

/** One read-only opener for every msgvault schema-aware adapter. */
export function openMsgvaultReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true })
}

export function readMsgvaultTableColumns(db: DatabaseSync, table: string): MsgvaultSchemaColumn[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as MsgvaultSchemaColumn[]
}

/** Shared strict v0.19 sources contract used by reads and sync discovery. */
export function validateMsgvaultSourcesSchema(columns: readonly MsgvaultSchemaColumn[]): string[] {
  const errors: string[] = []
  const id = columns.find((column) => column.name === 'id')
  const sourceType = columns.find((column) => column.name === 'source_type')
  const identifier = columns.find((column) => column.name === 'identifier')
  const primaryKeys = columns.filter((column) => column.pk > 0)
  if (!id || !/int/i.test(id.type) || id.pk !== 1 || primaryKeys.length !== 1) {
    errors.push('sources.id must have INTEGER affinity and be the single primary key')
  }
  if (!sourceType || !/(char|clob|text)/i.test(sourceType.type) || sourceType.notnull !== 1) {
    errors.push('sources.source_type must be NOT NULL with TEXT affinity')
  }
  if (!identifier || !/(char|clob|text)/i.test(identifier.type) || identifier.notnull !== 1) {
    errors.push('sources.identifier must be NOT NULL with TEXT affinity')
  }
  return errors
}

export function validateMsgvaultAccountIdentitiesSchema(columns: readonly MsgvaultSchemaColumn[]): string[] {
  const errors: string[] = []
  const source = columns.find((column) => column.name === 'source_id')
  const address = columns.find((column) => column.name === 'address')
  const signal = columns.find((column) => column.name === 'source_signal')
  const confirmed = columns.find((column) => column.name === 'confirmed_at')
  const primaryKeys = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)
  if (!source || !/int/i.test(source.type) || source.notnull !== 1 || source.pk !== 1) {
    errors.push('account_identities.source_id must be NOT NULL INTEGER and primary-key part 1')
  }
  if (!address || !/(char|clob|text)/i.test(address.type) || address.notnull !== 1 || address.pk !== 2) {
    errors.push('account_identities.address must be NOT NULL TEXT and primary-key part 2')
  }
  if (primaryKeys.length !== 2 || primaryKeys[0]?.name !== 'source_id' || primaryKeys[1]?.name !== 'address') {
    errors.push('account_identities primary key must be exactly (source_id,address)')
  }
  if (!signal || !/(char|clob|text)/i.test(signal.type) || signal.notnull !== 1 || signal.dflt_value !== "''") {
    errors.push("account_identities.source_signal must be NOT NULL TEXT DEFAULT ''")
  }
  if (!confirmed || !/(date|time|char|clob|text)/i.test(confirmed.type) || confirmed.notnull !== 1 ||
      !/current_timestamp/i.test(String(confirmed.dflt_value ?? ''))) {
    errors.push('account_identities.confirmed_at must be NOT NULL DATETIME DEFAULT CURRENT_TIMESTAMP')
  }
  return errors
}

export function validateMsgvaultMessageBodiesSchema(columns: readonly MsgvaultSchemaColumn[]): string[] {
  const errors: string[] = []
  const message = columns.find((column) => column.name === 'message_id')
  const text = columns.find((column) => column.name === 'body_text')
  const html = columns.find((column) => column.name === 'body_html')
  const primaryKeys = columns.filter((column) => column.pk > 0)
  if (!message || !/int/i.test(message.type) || message.pk !== 1 || primaryKeys.length !== 1) {
    errors.push('message_bodies.message_id must have INTEGER affinity and be the single primary key')
  }
  if (!text || !/(char|clob|text)/i.test(text.type)) {
    errors.push('message_bodies.body_text must have TEXT affinity')
  }
  if (!html || !/(char|clob|text)/i.test(html.type)) {
    errors.push('message_bodies.body_html must have TEXT affinity')
  }
  return errors
}
