// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireDataDirectoryLock } from '../../src/mail/store/product/dataDirectoryLock.js'

describe('data-directory flock', () => {
  it('excludes a second owner, records pid/start metadata, and releases cleanly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mail-lock-'))
    const first = await acquireDataDirectoryLock(directory)
    try {
      const metadata = JSON.parse(readFileSync(first.path, 'utf8')) as Record<string, unknown>
      expect(metadata.pid).toBe(process.pid)
      expect(metadata.processStartedAt).toEqual(expect.any(String))
      await expect(acquireDataDirectoryLock(directory)).rejects.toMatchObject({
        code: 'mail_store_already_active',
      })
    } finally {
      await first.release()
    }
    const next = await acquireDataDirectoryLock(directory)
    await next.release()
  })
})
