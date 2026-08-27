import {
  openMsgvaultReadOnly,
  readMsgvaultTableColumns,
  validateMsgvaultSourcesSchema,
} from '../store/msgvault/schema.ts'

export interface MsgvaultAccountDiscoveryOptions {
  dbPath: string
}

function remediation(message: string): Error {
  return new Error(`REMEDIATION: ${message}`)
}

/** Discover active Gmail source identifiers through the shared v0.19 schema seam. */
export async function discoverMsgvaultGmailAccounts(
  options: MsgvaultAccountDiscoveryOptions,
): Promise<string[]> {
  let db
  try {
    db = openMsgvaultReadOnly(options.dbPath)
  } catch {
    throw remediation('cannot open the msgvault database; run msgvault init-db or configure MSGVAULT_HOME')
  }
  try {
    const errors = validateMsgvaultSourcesSchema(readMsgvaultTableColumns(db, 'sources'))
    if (errors.length > 0) {
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
