// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigFromFile } from 'vite'

const roots: string[] = []
const envKeys = [
  'BORING_MAIL_DEPLOYMENT_MODE',
  'BORING_MAIL_OWNER_TOKEN_FILE',
  'BORING_MAIL_BIND_HOST',
  'BORING_MAIL_HMR_HOST',
  'BORING_MAIL_ALLOWED_ORIGIN',
  'BORING_MAIL_FIXTURE_ROOT',
  'BORING_MAIL_TRUST_TAILNET_HTTP',
] as const

function tokenFile(root: string): string {
  const path = join(root, 'owner-token')
  writeFileSync(path, Buffer.alloc(32, 9).toString('base64url'), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

afterEach(() => {
  for (const key of envKeys) delete process.env[key]
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Vite config serve boundary', () => {
  it('loads serve config with a safe fixture env through static analyzable imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bm-vite-config-'))
    roots.push(root)
    process.env.BORING_MAIL_DEPLOYMENT_MODE = 'fixture'
    process.env.BORING_MAIL_OWNER_TOKEN_FILE = tokenFile(root)
    process.env.BORING_MAIL_BIND_HOST = '127.0.0.1'
    process.env.BORING_MAIL_HMR_HOST = '127.0.0.1'
    process.env.BORING_MAIL_ALLOWED_ORIGIN = 'http://127.0.0.1:5190'
    process.env.BORING_MAIL_FIXTURE_ROOT = root

    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false },
      resolve(import.meta.dirname, '../../vite.config.ts'),
      resolve(import.meta.dirname, '../..'),
      'silent',
      undefined,
      'bundle',
    )
    expect(loaded?.config.server).toMatchObject({ host: '127.0.0.1', port: 5190, strictPort: true })
    expect(loaded?.config.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'boring-mail-agent-backend' })]))
  }, 30_000)
})
