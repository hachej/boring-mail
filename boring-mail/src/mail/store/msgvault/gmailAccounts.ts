import {
  openMsgvaultReadOnly,
  readMsgvaultTableColumns,
  validateMsgvaultSourcesSchema,
} from './schema.ts'

export interface MsgvaultGmailAccountDiscoveryOptions {
  dbPath: string
}

function remediation(message: string): Error {
  return new Error(`REMEDIATION: ${message}`)
}

function validExactGmailIdentifier(account: string): boolean {
  return account.length > 0 && account.length <= 320 && account === account.trim() &&
    !/[\s\x00-\x1F\x7F]/u.test(account) &&
    account.indexOf('@') > 0 && account.indexOf('@') === account.lastIndexOf('@') && !account.endsWith('@')
}

/** Typed v0.19 archive-reader boundary for Gmail source identifiers. */
export async function discoverMsgvaultGmailAccounts(
  options: MsgvaultGmailAccountDiscoveryOptions,
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
      // msgvault 0.19 resolves source identifiers by exact spelling. Reject
      // surrounding whitespace instead of silently changing the lookup key.
      const account = row.identifier
      if (!validExactGmailIdentifier(account)) {
        throw remediation('msgvault Gmail account identifier is invalid')
      }
      const canonical = account.toLowerCase()
      if (seen.has(canonical)) throw remediation('msgvault contains duplicate Gmail account identifiers')
      seen.add(canonical)
      return account
    })
  } finally {
    db.close()
  }
}
