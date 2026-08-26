import { DatabaseSync } from 'node:sqlite'
import { ProductStoreError } from './types.js'

export const PRODUCT_SCHEMA_VERSION = 1

const V1_SCHEMA = `
CREATE TABLE mail_accounts (
  account_id TEXT PRIMARY KEY,
  provider_source_id INTEGER NOT NULL UNIQUE,
  primary_address TEXT NOT NULL,
  send_as_json TEXT NOT NULL,
  connected INTEGER NOT NULL CHECK (connected IN (0,1)),
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE mail_drafts (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision > 0),
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
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  CHECK ((reply_rfc822_message_id IS NULL) = (reply_source_id IS NULL))
) STRICT;

CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES mail_drafts(id),
  draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
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
  message_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending_approval','approved','claimed','dispatched','sent','unknown','rejected','stale'
  )),
  approval_cap_hash TEXT,
  approval_expires_ms INTEGER,
  approval_consumed_ms INTEGER,
  lease_owner TEXT,
  lease_expires_ms INTEGER,
  provider_message_id TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  UNIQUE(account_id, message_id),
  CHECK ((reply_rfc822_message_id IS NULL) = (reply_source_id IS NULL)),
  CHECK ((approval_cap_hash IS NULL) = (approval_expires_ms IS NULL)),
  CHECK (status = 'pending_approval' OR (approval_cap_hash IS NULL AND approval_expires_ms IS NULL)),
  CHECK (
    (status = 'pending_approval' AND approval_consumed_ms IS NULL AND lease_owner IS NULL AND lease_expires_ms IS NULL AND provider_message_id IS NULL) OR
    (status = 'approved' AND approval_consumed_ms IS NOT NULL AND lease_owner IS NULL AND lease_expires_ms IS NULL AND provider_message_id IS NULL) OR
    (status IN ('claimed','dispatched') AND approval_consumed_ms IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_ms IS NOT NULL AND provider_message_id IS NULL) OR
    (status = 'sent' AND approval_consumed_ms IS NOT NULL AND lease_owner IS NULL AND lease_expires_ms IS NULL AND provider_message_id IS NOT NULL) OR
    (status = 'unknown' AND approval_consumed_ms IS NOT NULL AND lease_owner IS NULL AND lease_expires_ms IS NULL AND provider_message_id IS NULL) OR
    (status = 'rejected' AND approval_consumed_ms IS NULL AND lease_owner IS NULL AND lease_expires_ms IS NULL AND provider_message_id IS NULL) OR
    (status = 'stale' AND lease_owner IS NULL AND lease_expires_ms IS NULL AND provider_message_id IS NULL)
  )
) STRICT;
CREATE INDEX idx_mail_outbox_status ON mail_outbox(status, account_id);
CREATE TRIGGER mail_outbox_snapshot_immutable
BEFORE UPDATE OF
  draft_id,draft_revision,account_id,send_as_address,reply_rfc822_message_id,reply_source_id,
  to_json,cc_json,bcc_json,subject,body_markdown,attachments_json,message_id,content_digest
ON mail_outbox
BEGIN
  SELECT RAISE(ABORT, 'mail_outbox send snapshot is immutable');
END;

CREATE TABLE mail_attention (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('approval_required','send_unknown')),
  account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),
  outbox_id TEXT NOT NULL REFERENCES mail_outbox(id),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  resolved_ms INTEGER,
  created_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_mail_attention_open ON mail_attention(resolved_ms, created_ms);
CREATE UNIQUE INDEX idx_mail_attention_unique_open
  ON mail_attention(outbox_id, kind) WHERE resolved_ms IS NULL;
`

/** Ordered, atomic migration entrypoint. Empty v0 databases are the only v0 input. */
export function migrateProductDatabase(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (version > PRODUCT_SCHEMA_VERSION) {
    throw new ProductStoreError(
      'unsupported_schema',
      `product database schema ${version} is newer than supported ${PRODUCT_SCHEMA_VERSION}`,
    )
  }
  if (version === PRODUCT_SCHEMA_VERSION) return

  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'mail_%'
    `).all() as Array<{ name: string }>
    if (existing.length > 0) {
      throw new ProductStoreError(
        'unsupported_schema',
        'unversioned product tables found; migrate or recreate the unreleased development database',
      )
    }
    db.exec(V1_SCHEMA)
    db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
