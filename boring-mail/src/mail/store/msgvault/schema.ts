import { DatabaseSync } from 'node:sqlite'

export interface MsgvaultSchemaColumn {
  name: string
  type: string
  notnull: number
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
