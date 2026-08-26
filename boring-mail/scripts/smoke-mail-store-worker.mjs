import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { openMailStore } from '@hachej/boring-mail/mail-store'

const directory = mkdtempSync(join(tmpdir(), 'boring-mail-worker-smoke-'))
const productDbPath = join(directory, 'boring-mail.db')
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

try {
  const store = await openMailStore({ productDbPath }, {
    startupTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
  })
  await store.upsertAccount({
    accountId: 'smoke', providerSourceId: 1,
    primaryAddress: 'smoke@example.test', sendAs: ['smoke@example.test'],
  })
  const draft = await store.saveDraft({
    kind: 'compose', path: 'smoke.mail.md', accountId: 'smoke',
    sendAsAddress: 'smoke@example.test', to: ['recipient@example.test'],
    subject: 'worker smoke', bodyMarkdown: 'ok',
  }, 'smoke-draft')
  const queued = await store.outbox.enqueue(draft.id, 'smoke-operation')
  if (queued.status !== 'pending_approval') throw new Error(`unexpected outbox state ${queued.status}`)

  const metadata = JSON.parse(readFileSync(join(directory, '.boring-mail.lock'), 'utf8'))
  if (metadata.pid !== process.pid || typeof metadata.processStartedAt !== 'string') {
    throw new Error('lock metadata lacks host pid/start time')
  }
  const blocked = childOpen()
  if (!blocked.stdout.includes('ERROR:mail_store_already_active')) {
    throw new Error(`second process was not locked out: ${blocked.stdout}${blocked.stderr}`)
  }

  await store.close()
  const reopened = childOpen()
  if (!reopened.stdout.includes('OPENED')) {
    throw new Error(`lock was not released for second process: ${reopened.stdout}${reopened.stderr}`)
  }

  // Lock-health proof: killing the post-acquisition helper must fail-stop the
  // database worker before a replacement owner is admitted.
  const lossStore = await openMailStore({ productDbPath }, {
    startupTimeoutMs: 3_000, requestTimeoutMs: 3_000,
  })
  const processes = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout
    .trim().split('\n').map((line) => {
      const [pid, ppid, ...command] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), command: command.join(' ') }
    })
  const descendants = new Set([process.pid])
  for (let pass = 0; pass < 4; pass++) {
    for (const item of processes) if (descendants.has(item.ppid)) descendants.add(item.pid)
  }
  const holders = processes.filter((item) =>
    descendants.has(item.pid) && ['cat', 'sh', 'flock'].includes(item.command))
  if (!holders.some((item) => item.command === 'flock')) throw new Error('could not locate flock holder process')
  for (const item of holders.reverse()) {
    try { process.kill(item.pid, 'SIGKILL') } catch { /* descendant already exited */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  let lockLossObserved = false
  try { await lossStore.getDraft('after-lock-loss') }
  catch { lockLossObserved = true }
  if (!lockLossObserved) throw new Error('store continued serving after kernel lock loss')
  await lossStore.close()
  const afterLockLoss = await openMailStore({ productDbPath }, {
    startupTimeoutMs: 3_000, requestTimeoutMs: 3_000,
  })
  await afterLockLoss.close()

  // Crash proof: SIGKILL the host without closing; the flock helper must lose
  // its stdin and the kernel lock must become available without stale cleanup.
  const holder = spawn(process.execPath, ['-e', childSource, moduleUrl, productDbPath, 'hold'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForOutput(holder, 'OPENED')
  const holderExited = new Promise((resolve) => holder.once('exit', resolve))
  holder.kill('SIGKILL')
  await holderExited
  const afterCrash = await openMailStore({ productDbPath }, {
    startupTimeoutMs: 3_000, requestTimeoutMs: 3_000,
  })
  await afterCrash.close()
  console.log('✓ emitted mail-store worker, RPC, and cross-process flock smoke')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
