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

function runScenario(name, options) {
  const { total, ineligiblePrefix = 0, nonEmailPrefix = 0, highFanout = 0 } = options
  if (ineligiblePrefix && nonEmailPrefix) throw new Error('benchmark prefixes are mutually exclusive')
  const prefix = ineligiblePrefix + nonEmailPrefix
  const eligibleCount = total - prefix
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
        (3,3,'email_thread',NULL,0,0,NULL,NULL),
        (4,2,'calendar',NULL,0,0,NULL,NULL);
    `)
    if (ineligiblePrefix > 0) {
      writer.exec(`WITH RECURSIVE n(x) AS (
        VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${ineligiblePrefix}
      ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
        SELECT x,1,1,'<'||x||'@archive.test>','email',datetime('2040-01-01','-'||x||' seconds')||'+00:00',1,0 FROM n`)
    }
    if (nonEmailPrefix > 0) {
      writer.exec(`WITH RECURSIVE n(x) AS (
        VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${nonEmailPrefix}
      ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
        SELECT x,4,2,'<'||x||'@calendar.test>','calendar',datetime('2040-01-01','-'||x||' seconds')||'+00:00',1,0 FROM n`)
    }
    writer.exec(`WITH RECURSIVE n(x) AS (
      VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${eligibleCount}
    ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,is_read,attachment_count)
      SELECT ${prefix}+x,2,2,
        CASE
          WHEN ${highFanout}>0 AND x<=${highFanout} THEN '<high-fanout@bench.test>'
          WHEN ${highFanout}=0 AND x<=1000 THEN '<duplicate-'||CAST((x+1)/2 AS INTEGER)||'@bench.test>'
          ELSE '<eligible-'||x||'@bench.test>'
        END,
        'email',datetime('2030-01-01','-'||x||' seconds')||'+00:00',1,0 FROM n`)
    if (highFanout === 0) {
      writer.exec(`UPDATE messages SET conversation_id=3,source_id=3
        WHERE id>${prefix} AND id<=${prefix + Math.min(1000, eligibleCount)} AND id%2=0`)
    }
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
    const expectedIds = []
    for (let x = 1; x <= eligibleCount; x++) {
      if (highFanout > 0 ? x > 1 && x <= highFanout : x <= 1000 && x % 2 === 0) continue
      expectedIds.push(prefix + x)
    }

    const pages = []
    const seen = []
    let cursor
    for (let pageNumber = 0; pageNumber < 5 && seen.length < expectedIds.length; pageNumber++) {
      const timed = timedPage(store.db, eligible, authority, { limit: 200, ...(cursor ? { cursor } : {}) })
      pages.push(timed.elapsedMs)
      seen.push(...timed.page.items.map((item) => item.messageId))
      cursor = timed.page.nextCursor ?? undefined
      if (!cursor) break
    }
    const expected = expectedIds.slice(0, seen.length)
    if (JSON.stringify(seen) !== JSON.stringify(expected) || new Set(seen).size !== seen.length) {
      throw new Error(`${name} traversal differs from the synthetic oracle`)
    }
    if (seen.length < Math.min(800, expectedIds.length)) {
      throw new Error(`${name} did not traverse a meaningful deep page`)
    }
    const first = listUnifiedInbox(store.db, eligible, authority, { limit: 200 })
    if (highFanout > 0) {
      const group = first.items.find((item) => item.rfc822MessageId === '<high-fanout@bench.test>')
      if (!group || group.messageId !== prefix + 1 || group.copyCount !== highFanout || !group.coalesced) {
        throw new Error(`${name} high-fanout group was not coalesced exactly once`)
      }
    }
    const after = {
      messageAt: first.items.at(-1)?.messageAt ?? null,
      messageId: first.items.at(-1)?.messageId ?? 1,
    }
    const recentPlan = explainUnifiedInboxQueryPlan(store.db, eligible, after, 'recent-window')
    const fallbackPlan = explainUnifiedInboxQueryPlan(store.db, eligible, after, 'source-fallback')
    const recentEvidence = recentPlan.filter((detail) => /(?:SCAN|SEARCH) candidate USING INDEX/.test(detail))
    const fallbackEvidence = fallbackPlan.filter((detail) => /(?:SCAN|SEARCH) candidate USING INDEX/.test(detail))
    if (!recentEvidence.some((detail) => /live_message_recency/.test(detail))) {
      throw new Error(`${name} recent plan does not use live_message_recency`)
    }
    if (!fallbackEvidence.some((detail) => /SEARCH candidate USING INDEX messages_by_source/.test(detail))) {
      throw new Error(`${name} fallback plan does not search messages_by_source`)
    }
    return {
      name,
      total,
      ineligiblePrefix,
      nonEmailPrefix,
      highFanout,
      firstPageMs: pages[0],
      deepPageMs: pages.at(-1),
      traversed: seen.length,
      exactOracle: true,
      plan: { recentWindow: recentEvidence, sourceFallback: fallbackEvidence },
    }
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const results = [
  runScenario('baseline-100k', { total: 100_000 }),
  runScenario('sparse-500k', { total: 500_000, ineligiblePrefix: 498_000 }),
  runScenario('non-email-prefix-100k', { total: 100_000, nonEmailPrefix: 98_000 }),
  runScenario('high-fanout-50k', { total: 50_000, highFanout: 30_000 }),
]
console.log(JSON.stringify(results, null, 2))
// Evidence tripwire, not a microbenchmark promise. Multi-second first-page
// latency means the read-only archive needs a different indexed seam.
if (results.some((result) => result.firstPageMs > 2_000)) {
  throw new Error('a scale scenario exceeded the interactive evidence bound')
}
