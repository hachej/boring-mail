import { DatabaseSync } from 'node:sqlite'
import { ProductStoreError } from './types.js'
export const PRODUCT_SCHEMA_VERSION = 1

const V1_SCHEMA = `
CREATE TABLE mail_accounts (account_id TEXT PRIMARY KEY,provider_source_id INTEGER NOT NULL UNIQUE,primary_address TEXT NOT NULL,send_as_json TEXT NOT NULL CHECK(json_valid(send_as_json) AND json_type(send_as_json)='array'),connected INTEGER NOT NULL CHECK(connected IN(0,1)),created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL) STRICT;
CREATE TABLE mail_drafts (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>0),account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),send_as_address TEXT NOT NULL,reply_message_id INTEGER,reply_rfc822_message_id TEXT,reply_source_id INTEGER,to_json TEXT NOT NULL CHECK(json_valid(to_json) AND json_type(to_json)='array'),cc_json TEXT NOT NULL CHECK(json_valid(cc_json) AND json_type(cc_json)='array'),bcc_json TEXT NOT NULL CHECK(json_valid(bcc_json) AND json_type(bcc_json)='array'),subject TEXT NOT NULL,body_markdown TEXT NOT NULL,attachments_json TEXT NOT NULL CHECK(json_valid(attachments_json) AND json_type(attachments_json)='array'),content_digest TEXT NOT NULL,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,CHECK((reply_message_id IS NULL)=(reply_rfc822_message_id IS NULL) AND (reply_message_id IS NULL)=(reply_source_id IS NULL))) STRICT;
CREATE TABLE mail_outbox (
 id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES mail_drafts(id),draft_revision INTEGER NOT NULL CHECK(draft_revision>0),account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),send_as_address TEXT NOT NULL,reply_message_id INTEGER,reply_rfc822_message_id TEXT,reply_source_id INTEGER,
 to_json TEXT NOT NULL CHECK(json_valid(to_json) AND json_type(to_json)='array'),cc_json TEXT NOT NULL CHECK(json_valid(cc_json) AND json_type(cc_json)='array'),bcc_json TEXT NOT NULL CHECK(json_valid(bcc_json) AND json_type(bcc_json)='array'),subject TEXT NOT NULL,body_markdown TEXT NOT NULL,attachments_json TEXT NOT NULL CHECK(json_valid(attachments_json) AND json_type(attachments_json)='array'),message_id TEXT NOT NULL,content_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('pending_approval','approved','claimed','dispatched','unknown','human_decision','sent','failed','rejected','cancelled','stale')),
 approval_cap_hash TEXT,approval_session_hash TEXT,approval_expires_ms INTEGER,approval_consumed_ms INTEGER,lease_owner TEXT,lease_expires_ms INTEGER,reconcile_deadline_ms INTEGER,reconcile_next_ms INTEGER,reconcile_attempts INTEGER,reconcile_detail TEXT,provider_message_id TEXT,delivery_basis TEXT,failure_code TEXT,failure_detail TEXT,terminal_reason TEXT,retry_of TEXT REFERENCES mail_outbox(id),created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,
 UNIQUE(account_id,message_id),CHECK((reply_message_id IS NULL)=(reply_rfc822_message_id IS NULL) AND (reply_message_id IS NULL)=(reply_source_id IS NULL)),
 CHECK((approval_cap_hash IS NULL)=(approval_session_hash IS NULL) AND (approval_cap_hash IS NULL)=(approval_expires_ms IS NULL)),
 CHECK(status='pending_approval' OR (approval_cap_hash IS NULL AND approval_session_hash IS NULL AND approval_expires_ms IS NULL)),
 CHECK(status IN('pending_approval','rejected') OR approval_consumed_ms IS NOT NULL OR status='stale'),
 CHECK(status NOT IN('pending_approval','rejected') OR approval_consumed_ms IS NULL),
 CHECK(status IN('claimed','dispatched') OR (lease_owner IS NULL AND lease_expires_ms IS NULL)),
 CHECK(status NOT IN('claimed','dispatched') OR (lease_owner IS NOT NULL AND lease_expires_ms IS NOT NULL)),
 CHECK((lease_owner IS NULL)=(lease_expires_ms IS NULL)),
 CHECK(status IN('unknown','human_decision') OR (reconcile_deadline_ms IS NULL AND reconcile_next_ms IS NULL AND reconcile_attempts IS NULL AND reconcile_detail IS NULL)),
 CHECK(status!='unknown' OR (reconcile_deadline_ms IS NOT NULL AND reconcile_next_ms IS NOT NULL AND reconcile_attempts IS NOT NULL AND reconcile_detail IS NOT NULL)),
 CHECK(status!='human_decision' OR (reconcile_deadline_ms IS NOT NULL AND reconcile_next_ms IS NULL AND reconcile_attempts IS NOT NULL AND reconcile_detail IS NOT NULL)),
 CHECK(reconcile_attempts IS NULL OR reconcile_attempts>=0),
 CHECK(status!='sent' OR (delivery_basis='provider' AND provider_message_id IS NOT NULL OR delivery_basis='human' AND provider_message_id IS NULL)),
 CHECK(status='sent' OR (delivery_basis IS NULL AND provider_message_id IS NULL)),CHECK(status!='failed' OR (failure_code IS NOT NULL AND failure_detail IS NOT NULL)),CHECK(status='failed' OR (failure_code IS NULL AND failure_detail IS NULL)),CHECK(status!='cancelled' OR terminal_reason IN('cancelled','retry')),CHECK(status='cancelled' OR terminal_reason IS NULL)
) STRICT;
CREATE INDEX idx_mail_outbox_status ON mail_outbox(status,account_id);CREATE INDEX idx_mail_outbox_reconcile ON mail_outbox(status,reconcile_next_ms);
CREATE TRIGGER mail_outbox_snapshot_immutable BEFORE UPDATE OF draft_id,draft_revision,account_id,send_as_address,reply_message_id,reply_rfc822_message_id,reply_source_id,to_json,cc_json,bcc_json,subject,body_markdown,attachments_json,message_id,content_digest,retry_of ON mail_outbox BEGIN SELECT RAISE(ABORT,'mail_outbox send snapshot is immutable'); END;
CREATE TABLE mail_attention (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('approval_required','send_unknown')),account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),outbox_id TEXT NOT NULL REFERENCES mail_outbox(id),title TEXT NOT NULL,detail TEXT NOT NULL,resolved_ms INTEGER,created_ms INTEGER NOT NULL) STRICT;
CREATE INDEX idx_mail_attention_open ON mail_attention(resolved_ms,created_ms);CREATE UNIQUE INDEX idx_mail_attention_unique_open ON mail_attention(outbox_id,kind) WHERE resolved_ms IS NULL;
`
const sendColumns = [
  'account_id',
  'send_as_address',
  'reply_message_id',
  'reply_rfc822_message_id',
  'reply_source_id',
  'to_json',
  'cc_json',
  'bcc_json',
  'subject',
  'body_markdown',
  'attachments_json',
]
const required: Record<string, string[]> = {
  mail_accounts: [
    'account_id',
    'provider_source_id',
    'primary_address',
    'send_as_json',
    'connected',
    'created_ms',
    'updated_ms',
  ],
  mail_drafts: ['id', 'path', 'revision', ...sendColumns, 'content_digest', 'created_ms', 'updated_ms'],
  mail_outbox: [
    'id',
    'draft_id',
    'draft_revision',
    ...sendColumns,
    'message_id',
    'content_digest',
    'status',
    'approval_cap_hash',
    'approval_session_hash',
    'approval_expires_ms',
    'approval_consumed_ms',
    'lease_owner',
    'lease_expires_ms',
    'reconcile_deadline_ms',
    'reconcile_next_ms',
    'reconcile_attempts',
    'reconcile_detail',
    'provider_message_id',
    'delivery_basis',
    'failure_code',
    'failure_detail',
    'terminal_reason',
    'retry_of',
    'created_ms',
    'updated_ms',
  ],
  mail_attention: ['id', 'kind', 'account_id', 'outbox_id', 'title', 'detail', 'resolved_ms', 'created_ms'],
}
function validate(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(required)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!info.length)
      throw new ProductStoreError('unsupported_schema', `current schema missing table ${table}`)
    const names = new Set(info.map((x) => x.name))
    const missing = columns.filter((x) => !names.has(x))
    if (missing.length)
      throw new ProductStoreError(
        'unsupported_schema',
        `current schema ${table} missing columns: ${missing.join(', ')}`,
      )
  }
  const objects = db.prepare(`SELECT type,name FROM sqlite_master`).all() as Array<{
    type: string
    name: string
  }>
  const names = new Set(objects.map((x) => `${x.type}:${x.name}`))
  for (const item of [
    'index:idx_mail_outbox_status',
    'index:idx_mail_outbox_reconcile',
    'index:idx_mail_attention_unique_open',
    'trigger:mail_outbox_snapshot_immutable',
  ])
    if (!names.has(item)) throw new ProductStoreError('unsupported_schema', `current schema missing ${item}`)
  const fk = db.prepare('PRAGMA foreign_key_check').all()
  if (fk.length) throw new ProductStoreError('corrupt_data', 'product database has foreign-key violations')
}
export function migrateProductDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > PRODUCT_SCHEMA_VERSION)
      throw new ProductStoreError(
        'unsupported_schema',
        `product database schema ${version} is newer than supported ${PRODUCT_SCHEMA_VERSION}`,
      )
    if (version === 0) {
      const existing = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mail_%'`)
        .all()
      if (existing.length)
        throw new ProductStoreError('unsupported_schema', 'unversioned product tables found')
      db.exec(V1_SCHEMA)
      db.exec(`PRAGMA user_version=${PRODUCT_SCHEMA_VERSION}`)
    }
    validate(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
