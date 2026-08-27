import { DatabaseSync } from 'node:sqlite'

export interface MsgvaultAccountDiscoveryOptions {
  dbPath: string
}

function remediation(message: string): Error {
  return new Error(`REMEDIATION: ${message}`)
}

/** Discover active Gmail source identifiers from msgvault without reading mail. */
export async function discoverMsgvaultGmailAccounts(
  options: MsgvaultAccountDiscoveryOptions,
): Promise<string[]> {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(options.dbPath, { readOnly: true })
  } catch {
    throw remediation('cannot open the msgvault database; run msgvault init-db or configure MSGVAULT_DB_PATH')
  }
  try {
    const table = db.prepare(`PRAGMA table_info(sources)`).all() as Array<{
      name: unknown; type: unknown; notnull: unknown; pk: unknown
    }>
    const id = table.find((column) => column.name === 'id')
    const type = table.find((column) => column.name === 'source_type')
    const identifier = table.find((column) => column.name === 'identifier')
    const primary = table.filter((column) => Number(column.pk) > 0)
    if (!id || typeof id.type !== 'string' || !/int/i.test(id.type) || id.pk !== 1 || primary.length !== 1 ||
        !type || typeof type.type !== 'string' || !/(char|clob|text)/i.test(type.type) || type.notnull !== 1 ||
        !identifier || typeof identifier.type !== 'string' || !/(char|clob|text)/i.test(identifier.type) || identifier.notnull !== 1) {
      throw remediation('msgvault sources schema drifted; this supervisor targets msgvault 0.19.x')
    }
    const rows = db.prepare(
      `SELECT identifier FROM sources WHERE source_type='gmail' ORDER BY id`,
    ).all() as Array<{ identifier: unknown }>
    const seen = new Set<string>()
    return rows.map((row) => {
      if (typeof row.identifier !== 'string') throw remediation('msgvault Gmail account identifier is not text')
      const account = row.identifier.trim().toLowerCase()
      if (!account || account.length > 320 || /[\s\x00-\x1f\x7f]/.test(account) ||
          account.indexOf('@') <= 0 || account.indexOf('@') !== account.lastIndexOf('@') || account.endsWith('@')) {
        throw remediation('msgvault Gmail account identifier is invalid')
      }
      if (seen.has(account)) throw remediation('msgvault contains duplicate Gmail account identifiers')
      seen.add(account)
      return account
    })
  } finally {
    db.close()
  }
}
