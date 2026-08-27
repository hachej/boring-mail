// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireMsgvaultArchiveLock } from '../src/mail/sync/msgvaultArchiveLock.js'
import { createMsgvaultSyncRunner } from '../src/mail/sync/msgvaultSyncRunner.js'

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for synthetic child')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function ownershipPaths(root: string): string[] {
  return [root, join(root, 'msgvault.db'), join(root, 'daemon.lock'), join(root, 'db.write.lock')]
}

function probe(path: string): number | null {
  return spawnSync('/usr/bin/flock', ['-n', '-E', '73', path, '/bin/true']).status
}

async function holdExternalLock(path: string): Promise<{ child: ChildProcess; release(): Promise<void> }> {
  const child = spawn('/usr/bin/flock', [path, '/bin/cat'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const deadline = Date.now() + 5_000
  try {
    while (probe(path) !== 73) {
      if (Date.now() >= deadline) throw new Error('timed out acquiring external synthetic lock')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return { child, async release() { child.stdin?.end(); await closed } }
  } catch (error) {
    child.stdin?.end()
    await closed
    throw error
  }
}

describe('msgvault archive ownership', () => {
  it('holds and releases cross-process archive inode ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-lock-'))
    const dbPath = join(root, 'msgvault.db')
    writeFileSync(dbPath, '')
    const lock = await acquireMsgvaultArchiveLock(dbPath)
    try {
      expect(ownershipPaths(root).map(probe)).toEqual([73, 73, 73, 73])
    } finally {
      await lock.release()
    }
    expect(ownershipPaths(root).map(probe)).toEqual([0, 0, 0, 0])
  })

  it('retains ownership after holder death until parent descriptors release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-holder-death-'))
    const dbPath = join(root, 'msgvault.db')
    writeFileSync(dbPath, '')
    const lock = await acquireMsgvaultArchiveLock(dbPath)
    try {
      process.kill(lock.holderPid, 'SIGKILL')
      await lock.holderClosed
      expect(ownershipPaths(root).map(probe)).toEqual([73, 73, 73, 73])
    } finally {
      await lock.release()
    }
    expect(ownershipPaths(root).map(probe)).toEqual([0, 0, 0, 0])
  })

  it('keeps ownership on an inherited sync child after owner descriptors close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-child-lock-'))
    const dbPath = join(root, 'msgvault.db')
    const executable = join(root, 'fake-msgvault')
    const readyPath = join(root, 'ready')
    const finishPath = join(root, 'finish')
    writeFileSync(dbPath, '')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs');for(const fd of [3,4,5,6])fs.fstatSync(fd);if(process.env.MSGVAULT_DAEMON_CLI_PARENT_PID!==String(process.ppid))process.exit(8);fs.writeFileSync(process.env.READY_PATH,'');
const wait=()=>fs.existsSync(process.env.FINISH_PATH)?console.log('Changes: 0 processed, 0 added'):setTimeout(wait,10);wait();
`)
    chmodSync(executable, 0o700)
    const previousReady = process.env.READY_PATH
    const previousFinish = process.env.FINISH_PATH
    process.env.READY_PATH = readyPath
    process.env.FINISH_PATH = finishPath
    let lock: Awaited<ReturnType<typeof acquireMsgvaultArchiveLock>> | null = null
    let running: Promise<{ changed: boolean }> | null = null
    try {
      lock = await acquireMsgvaultArchiveLock(dbPath)
      running = createMsgvaultSyncRunner({ executable, archiveLock: lock })('a@test')
      await waitForFile(readyPath)
      process.kill(lock.holderPid, 'SIGKILL')
      await lock.holderClosed
      await lock.release()
      expect(ownershipPaths(root).map(probe)).toEqual([73, 73, 73, 73])
      writeFileSync(finishPath, '')
      await expect(running).resolves.toEqual({ changed: false })
      expect(ownershipPaths(root).map(probe)).toEqual([0, 0, 0, 0])
    } finally {
      writeFileSync(finishPath, '')
      await running?.catch(() => undefined)
      await lock?.release().catch(() => undefined)
      if (previousReady === undefined) delete process.env.READY_PATH
      else process.env.READY_PATH = previousReady
      if (previousFinish === undefined) delete process.env.FINISH_PATH
      else process.env.FINISH_PATH = previousFinish
    }
  })

  it('refuses an existing msgvault daemon or direct writer lock', async () => {
    for (const lockName of ['daemon.lock', 'db.write.lock']) {
      const root = mkdtempSync(join(tmpdir(), `mv-existing-${lockName}-`))
      const dbPath = join(root, 'msgvault.db')
      writeFileSync(dbPath, '')
      const external = await holdExternalLock(join(root, lockName))
      try {
        await expect(acquireMsgvaultArchiveLock(dbPath)).rejects.toThrow(/another msgvault or Boring Mail process owns/)
      } finally {
        await external.release()
      }
      const lock = await acquireMsgvaultArchiveLock(dbPath)
      await lock.release()
    }
  })

  it('pins ownership utilities, rejects FIFO archives, and fails closed on home replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-lock-hardening-'))
    const dbPath = join(root, 'msgvault.db')
    writeFileSync(dbPath, '')
    const fakeBin = mkdtempSync(join(tmpdir(), 'mv-fake-path-'))
    writeFileSync(join(fakeBin, 'flock'), '#!/bin/sh\nprintf "ready\\n"\n'); chmodSync(join(fakeBin, 'flock'), 0o700)
    const previousPath = process.env.PATH
    process.env.PATH = fakeBin
    let lock: Awaited<ReturnType<typeof acquireMsgvaultArchiveLock>> | null = null
    try {
      lock = await acquireMsgvaultArchiveLock(dbPath)
      expect(ownershipPaths(root).map(probe)).toEqual([73, 73, 73, 73])
      const moved = `${root}-moved`
      renameSync(root, moved)
      mkdirSync(root)
      writeFileSync(join(root, 'msgvault.db'), '')
      expect(() => lock!.databasePath()).toThrow(/identity changed/)
      expect(() => lock!.spawnContext()).toThrow(/identity changed/)
    } finally {
      await lock?.release().catch(() => undefined)
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }

    const fifoRoot = mkdtempSync(join(tmpdir(), 'mv-fifo-'))
    const fifoPath = join(fifoRoot, 'msgvault.db')
    expect(spawnSync('/usr/bin/mkfifo', [fifoPath]).status).toBe(0)
    const started = Date.now()
    await expect(acquireMsgvaultArchiveLock(fifoPath)).rejects.toThrow(/single-link regular file/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

})
