// Reproducible bm-eii scale proof. Uses synthetic metadata only; no personal mail.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  explainUnifiedInboxQueryPlan,
  listUnifiedInbox,
  openMsgvaultStore,
} from '../dist/mail/store/msgvaultAdapter.js'

const SCHEMA = `
CREATE TABLE sources(id INTEGER PRIMARY KEY,identifier TEXT NOT NULL);
CREATE TABLE conversations(id INTEGER PRIMARY KEY,source_id INTEGER NOT NULL,conversation_type TEXT NOT NULL,title TEXT,message_count INTEGER,unread_count INTEGER,last_message_at TEXT,last_message_preview TEXT);
CREATE TABLE participants(id INTEGER,email_address TEXT,display_name TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,source_id INTEGER NOT NULL,rfc822_message_id TEXT,message_type TEXT NOT NULL,subject TEXT,snippet TEXT,sent_at TEXT,received_at TEXT,internal_date TEXT,is_read INTEGER,attachment_count INTEGER,sender_id INTEGER,deleted_at TEXT,deleted_from_source_at TEXT);
CREATE INDEX correlation_by_message_id ON messages(rfc822_message_id,source_id);
CREATE INDEX messages_by_source ON messages(source_id);
CREATE INDEX live_message_recency ON messages(COALESCE(sent_at,received_at,internal_date) DESC,id DESC) WHERE deleted_at IS NULL AND deleted_from_source_at IS NULL;
CREATE TABLE message_recipients(message_id INTEGER NOT NULL,recipient_type TEXT NOT NULL,email_address TEXT);
CREATE INDEX recipients_by_message ON message_recipients(message_id,recipient_type);
CREATE TABLE message_labels(message_id INTEGER,label_id INTEGER);
CREATE TABLE labels(id INTEGER,name TEXT);
CREATE TABLE message_raw(message_id INTEGER,raw_data BLOB,raw_format TEXT,compression TEXT);
CREATE TABLE attachments(id INTEGER,message_id INTEGER,filename TEXT,mime_type TEXT,size INTEGER,content_hash TEXT,storage_path TEXT);
CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED,subject);
`

function timedPage(db, eligible, authority, options) {
  const started = performance.now()
  const page = listUnifiedInbox(db, eligible, authority, options)
  return { page, elapsedMs: Number((performance.now() - started).toFixed(2)) }
}

function runScenario(name, total, ineligiblePrefix) {
  const root = mkdtempSync(join(tmpdir(), `boring-mail-${name}-`))
  const path = join(root, 'msgvault.db')
  const writer = new DatabaseSync(path)
  try {
    writer.exec(SCHEMA)
    writer.exec(`
      INSERT INTO sources VALUES(1,'archived@example.test'),(2,'connected@example.test'),(3,'alias@example.test');
      INSERT INTO conversations VALUES
        (1,1,'email_thread',NULL,0,0,NULL,NULL),
        (2,2,'email_thread',NULL,0,0,NULL,NULL),
        (3,3,'email_thread',NULL,0,0,NULL,NULL);
    `)
    if (ineligiblePrefix > 0) {
      writer.exec(`WITH RECURSIVE n(x) AS (
        VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${ineligiblePrefix}
      ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
        SELECT x,1,1,'<'||x||'@archive.test>','email',datetime('2040-01-01','-'||x||' seconds')||'+00:00',1,0 FROM n`)
    }
    const eligibleCount = total - ineligiblePrefix
    writer.exec(`WITH RECURSIVE n(x) AS (
      VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${eligibleCount}
    ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
      SELECT ${ineligiblePrefix}+x,2,2,
        CASE WHEN x<=1000 THEN '<duplicate-'||CAST((x+1)/2 AS INTEGER)||'@bench.test>' ELSE '<eligible-'||x||'@bench.test>' END,
        'email',datetime('2030-01-01','-'||x||' seconds')||'+00:00',1,0 FROM n`)
    // Half of the first 1,000 eligible rows are duplicate losers on another
    // connected source, exercising representative rejection after the sparse scan.
    writer.exec(`UPDATE messages SET conversation_id=3,source_id=3
      WHERE id>${ineligiblePrefix} AND id<=${ineligiblePrefix + Math.min(1000, eligibleCount)} AND id%2=0`)
  } finally {
    writer.close()
  }

  const store = openMsgvaultStore(path)
  try {
    const eligible = [
      { sourceId: 2, identities: ['connected@example.test'] },
      { sourceId: 3, identities: ['alias@example.test'] },
    ]
    const authority = { scope: `benchmark-${name}` }
    const first = timedPage(store.db, eligible, authority, { limit: 200 })
    if (!first.page.nextCursor) throw new Error(`${name} did not produce a deep cursor`)
    const deep = timedPage(store.db, eligible, authority, { limit: 200, cursor: first.page.nextCursor })
    const after = {
      messageAt: first.page.items.at(-1)?.messageAt ?? null,
      messageId: first.page.items.at(-1)?.messageId ?? 1,
    }
    const plan = {
      recentWindow: explainUnifiedInboxQueryPlan(store.db, eligible, after, 'recent-window')
        .filter((detail) => /(?:SCAN|SEARCH) candidate USING INDEX/.test(detail)),
      sourceFallback: explainUnifiedInboxQueryPlan(store.db, eligible, after, 'source-fallback')
        .filter((detail) => /(?:SCAN|SEARCH) candidate USING INDEX/.test(detail)),
    }
    return {
      name,
      total,
      ineligiblePrefix,
      firstPageMs: first.elapsedMs,
      deepPageMs: deep.elapsedMs,
      firstCount: first.page.items.length,
      deepCount: deep.page.items.length,
      plan,
    }
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const results = [
  runScenario('baseline-100k', 100_000, 0),
  runScenario('sparse-500k', 500_000, 498_000),
]
console.log(JSON.stringify(results, null, 2))
if (results.some((result) => result.firstCount !== 200 || result.deepCount !== 200)) process.exit(1)
// This is an evidence tripwire, not a microbenchmark promise. Multi-second
// first-page latency means the read-only archive needs a new indexed seam.
if (results[1].firstPageMs > 2_000) {
  throw new Error(`sparse 500k first page is not interactive: ${results[1].firstPageMs}ms`)
}
