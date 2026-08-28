import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openMailStore } from '@hachej/boring-mail/mail-store'

const directory = mkdtempSync(join(tmpdir(), 'boring-mail-worker-smoke-'))
const productDbPath = join(directory, 'boring-mail.db')
const msgvaultDbPath = join(directory, 'msgvault.db')
const msgvaultSchema = readFileSync(
  new URL('../tests/fixtures/msgvault-v0.19.sql', import.meta.url),
  'utf8',
)
{
  const fixture = new DatabaseSync(msgvaultDbPath)
  fixture.exec(msgvaultSchema)
  fixture.exec(`INSERT INTO sources(id,source_type,identifier) VALUES(1,'gmail','smoke@example.test');
    INSERT INTO account_identities(source_id,address) VALUES(1,'smoke@example.test');
    INSERT INTO participants(id,email_address,display_name) VALUES(1,'sender@example.test','Sender Smoke');
    INSERT INTO conversations(id,source_id,conversation_type,message_count,unread_count)
      VALUES(1,1,'email_thread',3,0);
    INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,subject,snippet,sender_id,sent_at,is_read,attachment_count)
    VALUES(1,1,1,'<one@example.test>','email','one','one',1,'2030-01-03 00:00:00+00:00',1,0),
          (2,1,1,'<two@example.test>','email','two','two',1,'2030-01-02 00:00:00+00:00',1,0),
          (3,1,1,'<three@example.test>','email','three','three',1,'2030-01-01 00:00:00+00:00',1,0)`)
  const hostileSubject = `Q\u0000\u0001\"😀`.repeat(256 * 1024)
  const hostileSnippet = `S\\\"\n😀`.repeat(256 * 1024)
  fixture.prepare(`UPDATE messages SET subject=?,snippet=?`).run(hostileSubject, hostileSnippet)
  fixture.close()
}
const moduleUrl = new URL('../dist/mail/store/productDb.js', import.meta.url).href
const childSource = `void (async () => {
  const { openMailStore } = await import(process.argv[1]);
  try {
    const store = await openMailStore({ productDbPath: process.argv[2] }, {
      startupTimeoutMs: 3000, requestTimeoutMs: 3000,
    });
    console.log('OPENED');
    if (process.argv[3] === 'hold') await new Promise(() => {});
    await store.close();
  } catch (error) {
    console.log('ERROR:' + String(error?.code ?? error?.message));
  }
})()`
const childOpen = () => spawnSync(
  process.execPath,
  ['-e', childSource, moduleUrl, productDbPath],
  { encoding: 'utf8', timeout: 10_000 },
)
const waitForOutput = (child, expected) => new Promise((resolve, reject) => {
  let output = ''
  const timeout = setTimeout(() => reject(new Error(`timed out waiting for child output: ${output}`)), 10_000)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
    if (!output.includes(expected)) return
    clearTimeout(timeout)
    resolve()
  })
  child.once('exit', (code) => {
    if (!output.includes(expected)) {
      clearTimeout(timeout)
      reject(new Error(`child exited ${code} before ${expected}: ${output}`))
    }
  })
})
const openEventually = async () => {
  let last
  for (let attempt = 0; attempt < 40; attempt++) {
    let candidate
    try {
      candidate = await openMailStore({ productDbPath }, {
        startupTimeoutMs: 3_000, requestTimeoutMs: 3_000,
      })
      await candidate.getDraft('__replacement_probe__')
      return candidate
    } catch (error) {
      last = error
      await candidate?.close().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw last
}

try {
  const ownerPath = join(directory, '.boring-mail.owner.json')
  const victim = join(directory, 'owner-victim.txt')
  writeFileSync(victim, 'do-not-truncate')
  symlinkSync(victim, ownerPath)
  const symlinkOwnerStore = await openMailStore({ productDbPath })
  await symlinkOwnerStore.listUnifiedInbox().then(
    () => { throw new Error('unconfigured msgvault unexpectedly listed inbox') },
    (error) => {
      if (error?.code !== 'msgvault_unavailable' || !String(error.message).includes('REMEDIATION')) {
        throw error
      }
    },
  )
  await symlinkOwnerStore.close()
  if (readFileSync(victim, 'utf8') !== 'do-not-truncate') throw new Error('owner symlink target was modified')
  rmSync(ownerPath)
  linkSync(victim, ownerPath)
  const hardlinkOwnerStore = await openMailStore({ productDbPath })
  await hardlinkOwnerStore.close()
  if (readFileSync(victim, 'utf8') !== 'do-not-truncate') throw new Error('owner hardlink target was modified')
  rmSync(ownerPath)
  await openMailStore({ productDbPath: ownerPath }).then(
    (store) => store.close().then(() => { throw new Error('reserved owner path opened as database') }),
    () => undefined,
  )

  // Spawn failure must fully dispose its registry tombstone so the same data
  // directory can open after the environment is repaired.
  const originalPath = process.env.PATH
  process.env.PATH = join(directory, 'missing-bin')
  await openMailStore({ productDbPath }, { startupTimeoutMs: 1_000 }).then(
    (store) => store.close().then(() => { throw new Error('missing flock unexpectedly started') }),
    () => undefined,
  )
  process.env.PATH = originalPath

  const store = await openMailStore({ productDbPath, msgvaultDbPath }, {
    startupTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
  })
  await store.upsertAccount({
    accountId: 'smoke', providerSourceId: 1,
    primaryAddress: 'smoke@example.test', sendAs: ['smoke@example.test'],
  })
  const firstInboxPage = await store.listUnifiedInbox({ limit: 1 })
  if (firstInboxPage.items.length !== 1 || !firstInboxPage.nextCursor) {
    throw new Error('public async unified inbox did not return a cursor page')
  }
  if (Buffer.byteLength(firstInboxPage.items[0].subject ?? '', 'utf8') > 1024 ||
      Buffer.byteLength(firstInboxPage.items[0].snippet ?? '', 'utf8') > 2048 ||
      !firstInboxPage.items[0].textTruncated.subject || !firstInboxPage.items[0].textTruncated.snippet) {
    throw new Error('emitted worker did not physically bound hostile provider text')
  }
  await store.listUnifiedInbox(null).then(
    () => { throw new Error('malformed unified inbox options were accepted') },
    (error) => { if (error?.code !== 'invalid_input') throw error },
  )
  await store.setReadSourceEnabled(1, false)
  await store.listUnifiedInbox({ cursor: firstInboxPage.nextCursor }).then(
    () => { throw new Error('read eligibility mutation did not invalidate unified inbox cursor') },
    (error) => { if (error?.code !== 'stale_cursor') throw error },
  )
  await store.setReadSourceEnabled(1, true)
  const identityCursor = (await store.listUnifiedInbox({ limit: 1 })).nextCursor
  if (!identityCursor) throw new Error('identity cursor fixture did not produce a next page')
  const identityWriter = new DatabaseSync(msgvaultDbPath)
  identityWriter.exec(`INSERT INTO account_identities(source_id,address) VALUES(1,'alias-smoke@example.test')`)
  identityWriter.close()
  await store.listUnifiedInbox({ cursor: identityCursor }).then(
    () => { throw new Error('read identity mutation did not invalidate unified inbox cursor') },
    (error) => { if (error?.code !== 'stale_cursor') throw error },
  )
  const dataCursor = (await store.listUnifiedInbox({ limit: 1 })).nextCursor
  if (!dataCursor) throw new Error('data cursor fixture did not produce a next page')
  const msgvaultWriter = new DatabaseSync(msgvaultDbPath)
  msgvaultWriter.exec(`INSERT INTO messages(id,conversation_id,source_id,rfc822_message_id,message_type,subject,sent_at,is_read,attachment_count)
    VALUES(4,1,1,'<four@example.test>','email','four','2030-01-04 00:00:00+00:00',1,0)`)
  msgvaultWriter.close()
  await store.listUnifiedInbox({ cursor: dataCursor }).then(
    () => { throw new Error('sync mutation did not invalidate unified inbox cursor') },
    (error) => { if (error?.code !== 'stale_cursor') throw error },
  )
  const restartCursor = (await store.listUnifiedInbox({ limit: 1 })).nextCursor
  if (!restartCursor) throw new Error('restart cursor fixture did not produce a next page')
  const draft = await store.saveDraft({
    kind: 'compose', path: 'smoke.mail.md', accountId: 'smoke',
    sendAsAddress: 'smoke@example.test', to: ['recipient@example.test'],
    subject: 'worker smoke', bodyMarkdown: 'ok',
  }, 'smoke-draft')
  const queued = await store.outbox.enqueue(draft.id, 'smoke-operation')
  if (queued.status !== 'pending_approval') throw new Error(`unexpected outbox state ${queued.status}`)
  const autoIdDraft = await store.saveDraft({
    kind: 'compose', path: 'auto-id.mail.md', accountId: 'smoke',
    sendAsAddress: 'smoke@example.test', to: ['recipient@example.test'],
    subject: 'optional argument smoke', bodyMarkdown: 'ok',
  })
  if (!autoIdDraft.id) throw new Error('omitted requestedId did not generate an id')
  const token = await store.outbox.issueApprovalCapability(queued.id, 'smoke-session')
  await store.outbox.approve(queued.id, token, 'smoke-session')
  if ((await store.outbox.listAttention()).length !== 0) throw new Error('omitted openOnly did not default true')
  const claimed = await store.outbox.claimNext('smoke-worker')
  if (!claimed) throw new Error('omitted lease did not claim approved work')
  await store.outbox.markDispatched(claimed.id, 'smoke-worker', '100')
  await store.outbox.markUnknown(claimed.id, 'smoke-worker', 'smoke ambiguity')
  if ((await store.outbox.dueReconciliations()).length !== 1) {
    throw new Error('omitted reconciliation limit did not use its default')
  }

  // Renaming/recreating the configured root and moving the same DB inode must
  // not bypass ownership: fd 5 remains locked by the original SQLite process.
  const movedDirectory = `${directory}.moved`
  renameSync(directory, movedDirectory)
  mkdirSync(directory)
  renameSync(join(movedDirectory, 'boring-mail.db'), productDbPath)
  const movedDbBlocked = childOpen()
  if (!movedDbBlocked.stdout.includes('ERROR:mail_store_already_active')) {
    throw new Error(`moved database inode bypassed lock: ${movedDbBlocked.stdout}${movedDbBlocked.stderr}`)
  }
  renameSync(productDbPath, join(movedDirectory, 'boring-mail.db'))
  rmSync(directory, { recursive: true, force: true })
  renameSync(movedDirectory, directory)

  const metadata = JSON.parse(readFileSync(ownerPath, 'utf8'))
  if (!Number.isSafeInteger(metadata.pid) || metadata.pid <= 0 || metadata.pid === process.pid ||
      typeof metadata.processStartedAt !== 'string') {
    throw new Error('owner metadata lacks storage pid/start time')
  }
  // Metadata is not lock authority: unlinking/replacing it cannot admit a
  // second owner because the canonical directory inode remains locked.
  rmSync(ownerPath)
  writeFileSync(ownerPath, 'non-authoritative replacement')
  const blocked = childOpen()
  if (!blocked.stdout.includes('ERROR:mail_store_already_active')) {
    throw new Error(`second process was not locked out: ${blocked.stdout}${blocked.stderr}`)
  }

  await store.close()
  const restartedStore = await openMailStore({ productDbPath, msgvaultDbPath })
  await restartedStore.listUnifiedInbox({ cursor: restartCursor }).then(
    () => { throw new Error('storage-process restart did not invalidate unified inbox cursor') },
    (error) => { if (error?.code !== 'stale_cursor') throw error },
  )
  await restartedStore.close()
  const reopened = childOpen()
  if (!reopened.stdout.includes('OPENED')) {
    throw new Error(`lock was not released for second process: ${reopened.stdout}${reopened.stderr}`)
  }

  process.env.BORING_MAIL_TEST_BLOCK_RPC = 'getDraft'
  const timeoutStore = await openMailStore({ productDbPath }, {
    startupTimeoutMs: 3_000, requestTimeoutMs: 40,
  })
  const timeoutOwner = JSON.parse(readFileSync(ownerPath, 'utf8')).pid
  const startedTimeout = Date.now()
  await timeoutStore.getDraft('blocked-timeout').then(
    () => { throw new Error('blocked real child RPC unexpectedly resolved') },
    (error) => { if (error?.code !== 'rpc_timeout') throw error },
  )
  delete process.env.BORING_MAIL_TEST_BLOCK_RPC
  const elapsedTimeout = Date.now() - startedTimeout
  if (elapsedTimeout > 1_000) throw new Error(`real child timeout did not fail-stop promptly: ${elapsedTimeout}ms`)
  const reopenStarted = Date.now()
  const afterTimeout = await openEventually()
  const reopenElapsed = Date.now() - reopenStarted
  if (reopenElapsed > 1_000) throw new Error(`timed out storage child held locks too long after SIGKILL: ${reopenElapsed}ms`)
  void timeoutOwner
  await timeoutStore.close()
  await afterTimeout.close()

  // Atomic owner proof: kill the process that owns both flock and SQLite while
  // a large synchronous write is in flight. The old RPC must reject, while a
  // replacement may open only after the kernel has released that same process's lock.
  const lossStore = await openMailStore({ productDbPath }, {
    startupTimeoutMs: 3_000, requestTimeoutMs: 3_000,
  })
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8')).pid
  let oldResolved = false
  const inFlight = lossStore.saveDraft({
    kind: 'compose', path: 'large.mail.md', accountId: 'smoke',
    sendAsAddress: 'smoke@example.test', to: ['recipient@example.test'],
    subject: 'large interrupted write', bodyMarkdown: 'x'.repeat(64 * 1024 * 1024),
  }, 'large-draft').then(() => { oldResolved = true }, () => undefined)
  await new Promise((resolve) => setTimeout(resolve, 1))
  process.kill(owner, 'SIGKILL')
  const replacementPromise = openEventually()
  await inFlight
  if (oldResolved) throw new Error('killed SQLite owner resolved an in-flight RPC')
  const replacement = await replacementPromise
  await lossStore.close()
  await replacement.close()

  // Crash proof: SIGKILL the host without closing; IPC disconnect must end the
  // lock-owning storage process and make the kernel lock available.
  const holder = spawn(process.execPath, ['-e', childSource, moduleUrl, productDbPath, 'hold'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForOutput(holder, 'OPENED')
  const holderExited = new Promise((resolve) => holder.once('exit', resolve))
  holder.kill('SIGKILL')
  await holderExited
  const afterCrash = await openEventually()
  await afterCrash.close()

  // Public declaration proof: a strict external NodeNext consumer resolves the
  // package export and domain/facade types without reaching into src/.
  const consumer = mkdtempSync(join(tmpdir(), 'boring-mail-type-consumer-'))
  const scope = join(consumer, 'node_modules', '@hachej')
  mkdirSync(scope, { recursive: true })
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  symlinkSync(packageRoot, join(scope, 'boring-mail'), 'dir')
  writeFileSync(join(consumer, 'index.ts'), `
    import { openMailStore, ProductStoreError, type DraftInput, type MailStore, type ReadSourceReconcileResult, type UnifiedInboxPage } from '@hachej/boring-mail/mail-store'
    const draft: DraftInput = { kind: 'compose', path: 'x.mail.md', accountId: 'a', sendAsAddress: 'a@x', to: ['b@x'], subject: '', bodyMarkdown: '' }
    const opened: Promise<MailStore> = openMailStore({ productDbPath: '/tmp/example.db' })
    const page: Promise<UnifiedInboxPage> = opened.then((store) => store.listUnifiedInbox({ limit: 25 }))
    const reconcile: Promise<ReadSourceReconcileResult> = opened.then((store) => store.reconcileMsgvaultReadSources())
    void draft; void opened; void page; void reconcile; void ProductStoreError
  `)
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: false,
  }, include: ['index.ts'] }))
  const tsc = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', join(consumer, 'tsconfig.json')], {
    encoding: 'utf8', cwd: consumer,
  })
  rmSync(consumer, { recursive: true, force: true })
  if (tsc.status !== 0) throw new Error(`strict mail-store type consumer failed:\n${tsc.stdout}${tsc.stderr}`)
  console.error('✓ emitted mail-store process, atomic flock, RPC, and strict declaration smoke')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
