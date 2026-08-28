// @vitest-environment node
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceBridgeOperationDefinition } from '@hachej/boring-workspace/server'
import {
  BORING_MAIL_PROXY_PRINCIPAL_HEADER,
  BORING_MAIL_PROXY_PROOF_HEADER,
  BORING_MAIL_READ_CAPABILITY,
  BORING_MAIL_WORKSPACE_ID,
  createStandaloneHostAuth,
  readVerifiedTokenFile,
  resolveStandaloneDeploymentConfig,
  type StandaloneHostAuthOptions,
} from './standaloneHostAuth'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'boring-mail-host-auth-'))
  roots.push(root)
  return root
}

function makeTokenFile(root = temporaryRoot(), bytes = randomBytes(32)): { path: string; text: string } {
  const path = join(root, 'owner.token')
  const text = bytes.toString('base64url')
  writeFileSync(path, text, { mode: 0o600 })
  return { path, text }
}

function topology(tokenFile: string, port = 5190): StandaloneHostAuthOptions {
  return {
    tokenFile,
    bindHost: '127.0.0.1',
    hmrHost: '127.0.0.1',
    allowedOrigin: `http://127.0.0.1:${port}`,
    backendOrigin: 'http://127.0.0.1:5290',
    trustTailnetHttp: true,
    readTailscaleStatus: () => JSON.stringify({
      BackendState: 'Running',
      Self: { Online: true, TailscaleIPs: ['127.0.0.1'] },
    }),
    trustedProof: Buffer.alloc(32, 7),
  }
}

function bridgeDefinition(requiredCapabilities = [BORING_MAIL_READ_CAPABILITY]): WorkspaceBridgeOperationDefinition {
  return {
    op: 'boring-mail.v1.inbox.list',
    version: 1,
    owner: BORING_MAIL_WORKSPACE_ID,
    callerClassesAllowed: ['browser'],
    requiredCapabilities,
    inputSchema: {},
    timeoutMs: 10_000,
    maxInputBytes: 4096,
    maxOutputBytes: 512 * 1024,
    idempotencyPolicy: 'none',
  } as WorkspaceBridgeOperationDefinition
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('standalone deployment config', () => {
  it('requires an explicit live or fixture mode and rejects synthetic/live path ambiguity', () => {
    const { path } = makeTokenFile()
    const env = {
      BORING_MAIL_OWNER_TOKEN_FILE: path,
      BORING_MAIL_BIND_HOST: '127.0.0.1',
      BORING_MAIL_HMR_HOST: '127.0.0.1',
      BORING_MAIL_ALLOWED_ORIGIN: 'http://127.0.0.1:5190',
      BORING_MAIL_TRUST_TAILNET_HTTP: '1',
    }
    expect(() => resolveStandaloneDeploymentConfig({ env, backendPort: 5290, defaultVitePort: 5190 })).toThrow(/DEPLOYMENT_MODE/)
    expect(() => resolveStandaloneDeploymentConfig({
      env: { ...env, BORING_MAIL_DEPLOYMENT_MODE: 'live', BORING_MAIL_FIXTURE_ROOT: '/tmp/fixture' },
      backendPort: 5290,
      defaultVitePort: 5190,
    })).toThrow(/FIXTURE_ROOT/)
    expect(() => resolveStandaloneDeploymentConfig({
      env: { ...env, BORING_MAIL_DEPLOYMENT_MODE: 'fixture', BORING_MAIL_MSGVAULT_PATH: '/home/user/.msgvault/mail.db' },
      backendPort: 5290,
      defaultVitePort: 5190,
    })).toThrow(/MSGVAULT_PATH/)
  })

  it('resolves the exact app-owned owner surface and loopback backend topology', () => {
    const { path } = makeTokenFile()
    const config = resolveStandaloneDeploymentConfig({
      env: {
        BORING_MAIL_DEPLOYMENT_MODE: 'live',
        BORING_MAIL_OWNER_TOKEN_FILE: path,
        BORING_MAIL_BIND_HOST: '127.0.0.1',
        BORING_MAIL_HMR_HOST: '127.0.0.1',
        BORING_MAIL_ALLOWED_ORIGIN: 'http://127.0.0.1:5190',
        BORING_MAIL_TRUST_TAILNET_HTTP: '1',
      },
      backendPort: 5290,
      defaultVitePort: 5190,
    })
    expect(config).toMatchObject({
      mode: 'live',
      bindHost: '127.0.0.1',
      hmrHost: '127.0.0.1',
      allowedOrigin: 'http://127.0.0.1:5190',
      backendOrigin: 'http://127.0.0.1:5290',
      workspaceId: 'default',
      trustTailnetHttp: true,
    })
  })
})

describe('production owner token descriptor', () => {
  it('accepts one canonical whitespace-free 0600 base64url token of at least 32 bytes', () => {
    const { path } = makeTokenFile()
    const token = readVerifiedTokenFile(path)
    expect(token).toHaveLength(32)
    token.fill(0)
  })

  it('fails closed for unsafe mode, short token, whitespace, symlink, hard link, special bits, and FIFO', () => {
    const root = temporaryRoot()
    const unsafeMode = makeTokenFile(root).path
    chmodSync(unsafeMode, 0o644)
    expect(() => readVerifiedTokenFile(unsafeMode)).toThrow(/0600/)

    const short = join(root, 'short.token')
    writeFileSync(short, Buffer.alloc(31).toString('base64url'), { mode: 0o600 })
    expect(() => readVerifiedTokenFile(short)).toThrow(/at least 32/)

    const whitespace = join(root, 'space.token')
    writeFileSync(whitespace, `${Buffer.alloc(32).toString('base64url')}\n`, { mode: 0o600 })
    expect(() => readVerifiedTokenFile(whitespace)).toThrow(/whitespace/)

    const target = join(root, 'target.token')
    writeFileSync(target, Buffer.alloc(32, 1).toString('base64url'), { mode: 0o600 })
    const symlink = join(root, 'symlink.token')
    symlinkSync(target, symlink)
    expect(() => readVerifiedTokenFile(symlink)).toThrow()

    const hardlink = join(root, 'hardlink.token')
    linkSync(target, hardlink)
    expect(() => readVerifiedTokenFile(target)).toThrow(/one hard link/)

    const special = makeTokenFile(root).path
    chmodSync(special, 0o4600)
    expect(() => readVerifiedTokenFile(special)).toThrow(/special bits/)

    const fifo = join(root, 'owner.fifo')
    execFileSync('mkfifo', ['-m', '600', fifo])
    const started = Date.now()
    expect(() => readVerifiedTokenFile(fifo)).toThrow(/not a regular file/)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('standalone topology and bridge auth policy', () => {
  it.each([
    ['wildcard bind', { bindHost: '0.0.0.0', hmrHost: '0.0.0.0', allowedOrigin: 'http://0.0.0.0:5190' }],
    ['mismatched HMR host', { hmrHost: '127.0.0.2' }],
    ['untrusted HTTP', { trustTailnetHttp: false }],
    ['unmodeled HTTPS', { allowedOrigin: 'https://127.0.0.1:5190', trustTailnetHttp: false }],
    ['non-loopback backend', { backendOrigin: 'http://100.64.0.2:5290' }],
    ['origin path', { allowedOrigin: 'http://127.0.0.1:5190/path' }],
    ['origin host mismatch', { allowedOrigin: 'http://127.0.0.2:5190' }],
  ])('rejects %s', (_label, override) => {
    const { path } = makeTokenFile()
    expect(() => createStandaloneHostAuth({ ...topology(path), ...override })).toThrow(/refused configuration/)
  })

  it('requires exact injected proof, exact origin, CSRF, default workspace, and mail-read capability', async () => {
    const { path } = makeTokenFile()
    const auth = createStandaloneHostAuth(topology(path))
    const headers = {
      origin: 'http://127.0.0.1:5190',
      'x-csrf-token': '1',
      [BORING_MAIL_PROXY_PROOF_HEADER]: Buffer.alloc(32, 7).toString('base64url'),
      [BORING_MAIL_PROXY_PRINCIPAL_HEADER]: 'owner',
    }

    await expect(auth.browserAuthPolicy.resolve({
      callerClass: 'browser',
      definition: bridgeDefinition(),
      workspaceId: 'default',
      request: { method: 'POST', headers },
    })).resolves.toMatchObject({ context: { callerClass: 'browser', workspaceId: 'default' } })

    for (const bad of [
      { headers: { ...headers, origin: 'http://127.0.0.2:5190' }, message: 'origin' },
      { headers: { ...headers, 'x-csrf-token': '' }, message: 'CSRF' },
      { headers: { ...headers, [BORING_MAIL_PROXY_PROOF_HEADER]: Buffer.alloc(32, 8).toString('base64url') }, message: 'proof' },
      { workspaceId: 'boring-mail', message: 'workspace' },
      { definition: bridgeDefinition(['workspace.files']), message: 'capability' },
    ]) {
      await expect(auth.browserAuthPolicy.resolve({
        callerClass: 'browser',
        definition: bad.definition ?? bridgeDefinition(),
        workspaceId: bad.workspaceId ?? 'default',
        request: { method: 'POST', headers: bad.headers ?? headers },
      })).rejects.toThrow()
    }
    auth.dispose()
  })
})
