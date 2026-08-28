// Reproducible synthetic thread-detail benchmark; no personal mail.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  explainThreadDetailQueryPlans,
  getUnifiedThreadInSnapshot,
  openMsgvaultStore,
} from '../dist/mail/store/msgvaultAdapter.js'

const SCHEMA = readFileSync(new URL('../tests/fixtures/msgvault-v0.19.sql', import.meta.url), 'utf8')
const root = mkdtempSync(join(tmpdir(), 'boring-mail-thread-detail-'))
const path = join(root, 'msgvault.db')
const writer = new DatabaseSync(path)
try {
  writer.exec('PRAGMA journal_mode=WAL')
  writer.exec(SCHEMA)
  writer.exec(`
    INSERT INTO sources(id,source_type,identifier) VALUES(1,'gmail','bench@example.invalid'),(2,'gmail','noise@example.invalid');
    INSERT INTO account_identities(source_id,address) VALUES(1,'bench@example.invalid');
    INSERT INTO conversations(id,source_id,conversation_type) VALUES(1,1,'email_thread'),(2,2,'email_thread'),(3,1,'calendar');
    INSERT INTO participants(id,email_address,display_name) VALUES(1,'sender@example.invalid','Sender'),(2,'bench@example.invalid','Bench');
  `)
  writer.exec(`WITH RECURSIVE n(x) AS (
    VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000
  ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,sender_id,is_read,attachment_count,deleted_at,deleted_from_source_at)
    SELECT x,1,1,'<bench-'||x||'@example.invalid>','email',datetime('2040-01-01','-'||x||' seconds')||'+00:00',
      'subject '||x,1,1,20,
      CASE WHEN x%251=0 THEN 'deleted' ELSE NULL END,
      CASE WHEN x%307=0 THEN 'deleted' ELSE NULL END
    FROM n`)
  writer.exec(`WITH RECURSIVE n(x) AS (
    VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000
  ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count)
    SELECT 30000+x,2,2,'<noise-'||x||'@example.invalid>','email',datetime('2041-01-01','-'||x||' seconds')||'+00:00','noise',1,0 FROM n`)
  writer.exec(`WITH RECURSIVE n(x) AS (
    VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000
  ) INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,sent_at,subject,is_read,attachment_count)
    SELECT 50000+x,3,1,'<calendar-'||x||'@example.invalid>','calendar',datetime('2042-01-01','-'||x||' seconds')||'+00:00','calendar',1,0 FROM n`)
  const hostileBody = `Quote " backslash \\ C0 \u0000 astral 😀\n`.repeat(4096)
  const body = writer.prepare(`INSERT INTO message_bodies(message_id,body_text,body_html) VALUES(?,?,?)`)
  for (let id = 1; id <= 25; id++) body.run(id, hostileBody, '<b>html</b>')
  const recipient = writer.prepare(`INSERT INTO message_recipients(id,message_id,participant_id,recipient_type,display_name,email_address) VALUES(?,?,?,?,?,?)`)
  const attachment = writer.prepare(`INSERT INTO attachments(id,message_id,filename,mime_type,size,content_hash,storage_path) VALUES(?,?,?,?,?,?,?)`)
  for (let message = 1; message <= 25; message++) {
    for (let fanout = 1; fanout <= 24; fanout++) {
      const id = message * 1000 + fanout
      recipient.run(id, message, 2, fanout % 3 === 0 ? 'bcc' : fanout % 2 === 0 ? 'cc' : 'to', `Recipient ${fanout}`, `r-${message}-${fanout}@example.invalid`)
      attachment.run(id, message, `file-${message}-${fanout}.txt`, 'text/plain', fanout, `hash-${id}`, `/private/${id}`)
    }
  }
} finally {
  writer.close()
}

try {
  const store = openMsgvaultStore(path)
  try {
    const eligible = [{ sourceId: 1, identities: ['bench@example.invalid'] }]
    for (let warm = 0; warm < 3; warm++) getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 25 })
    const started = performance.now()
    const detail = getUnifiedThreadInSnapshot(store.db, eligible, { messageId: 25 })
    const elapsedMs = Number((performance.now() - started).toFixed(2))
    const plan = explainThreadDetailQueryPlans(store.db, 25, eligible)
    const details = [...plan.candidates, ...plan.recipients, ...plan.attachments]
    if (details.some((entry) => /TEMP B-TREE/i.test(entry))) throw new Error('thread detail plan used a temporary b-tree')
    if (!plan.candidates.some((entry) => /USING INDEX idx_messages_conversation/.test(entry))) throw new Error('candidate query did not use conversation index')
    if (!plan.recipients.some((entry) => /USING INDEX idx_message_recipients_message/.test(entry))) throw new Error('recipient query did not use message index')
    if (!plan.attachments.some((entry) => /USING INDEX idx_attachments_message/.test(entry))) throw new Error('attachment query did not use message index')
    if (!detail || detail.messages.length !== 25 || !detail.messages.some((message) => message.selected)) {
      throw new Error('thread detail did not retain 25 messages including selected')
    }
    if (detail.messages.reduce((sum, message) => sum + message.recipients.length, 0) > 64 ||
        detail.messages.reduce((sum, message) => sum + message.attachments.length, 0) > 64) {
      throw new Error('thread detail exceeded metadata budgets')
    }
    const result = {
      elapsedMs,
      messageCount: detail.messages.length,
      selectedRetained: detail.messages.some((message) => message.selected && message.messageId === 25),
      historyTruncated: detail.historyTruncated,
      selectedOutsideRecentWindow: detail.selectedOutsideRecentWindow,
      metadataCounts: {
        recipients: detail.messages.reduce((sum, message) => sum + message.recipients.length, 0),
        attachments: detail.messages.reduce((sum, message) => sum + message.attachments.length, 0),
      },
      plan,
    }
    console.log(JSON.stringify(result, null, 2))
    if (elapsedMs > 250) throw new Error(`thread detail warmed benchmark exceeded 250ms: ${elapsedMs}ms`)
  } finally {
    store.db.close()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
