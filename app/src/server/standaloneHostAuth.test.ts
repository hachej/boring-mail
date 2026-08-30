// @vitest-environment node
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { createWorkspaceAgentServer } from '@hachej/boring-workspace/app/server'
import { defineTrustedDomainBridgeHandler, type WorkspaceBridgeOperationDefinition, type WorkspaceServerPlugin } from '@hachej/boring-workspace/server'
import {
  BORING_MAIL_PROXY_PRINCIPAL_HEADER,
  BORING_MAIL_PROXY_PROOF_HEADER,
  BORING_MAIL_PRESERVED_ASK_USER_BROWSER_CAPABILITIES,
  BORING_MAIL_READ_CAPABILITY,
  BORING_MAIL_WORKSPACE_ID,
  createStandaloneHostAuth,
  readVerifiedTokenFile,
  resolveStandaloneDeploymentConfig,
  type StandaloneHostAuthOptions,
} from './standaloneHostAuth'

const roots: string[] = []
const viteServers: ViteDevServer[] = []
const workspaceServers: Array<{ close(): Promise<unknown> }> = []

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

function bridgeDefinition(requiredCapabilities = [BORING_MAIL_READ_CAPABILITY], op = 'boring-mail.v1.inbox.list'): WorkspaceBridgeOperationDefinition {
  return {
    op,
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

function trustedSyntheticHandler(op: string, requiredCapabilities: readonly string[]): ReturnType<typeof defineTrustedDomainBridgeHandler> {
  return defineTrustedDomainBridgeHandler({
    op,
    version: 1,
    owner: 'ask-user',
    callerClassesAllowed: ['browser'],
    requiredCapabilities,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    timeoutMs: 1_000,
    maxInputBytes: 1_024,
    maxOutputBytes: 1_024,
    idempotencyPolicy: 'none',
    handler: async () => ({ status: 'ok' }),
  })
}

function bridgeHeaders(proofByte = 7, origin = 'http://127.0.0.1:5190'): Record<string, string> {
  return {
    origin,
    'x-csrf-token': '1',
    [BORING_MAIL_PROXY_PROOF_HEADER]: Buffer.alloc(32, proofByte).toString('base64url'),
    [BORING_MAIL_PROXY_PRINCIPAL_HEADER]: 'owner',
  }
}

afterEach(async () => {
  await Promise.allSettled(viteServers.splice(0).map((server) => server.close()))
  await Promise.allSettled(workspaceServers.splice(0).map((server) => server.close()))
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
    expect(() => resolveStandaloneDeploymentConfig({ env, backendPort: 5290, defaultVitePort: 5190, defaultWorkspaceRoot: temporaryRoot() })).toThrow(/DEPLOYMENT_MODE/)
    expect(() => resolveStandaloneDeploymentConfig({
      env: { ...env, BORING_MAIL_DEPLOYMENT_MODE: 'live', BORING_MAIL_FIXTURE_ROOT: '/tmp/fixture' },
      backendPort: 5290,
      defaultVitePort: 5190,
      defaultWorkspaceRoot: temporaryRoot(),
    })).toThrow(/FIXTURE_ROOT/)
    expect(() => resolveStandaloneDeploymentConfig({
      env: { ...env, BORING_MAIL_DEPLOYMENT_MODE: 'fixture', BORING_MAIL_MSGVAULT_PATH: '/home/user/.msgvault/mail.db' },
      backendPort: 5290,
      defaultVitePort: 5190,
      defaultWorkspaceRoot: temporaryRoot(),
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
      defaultWorkspaceRoot: temporaryRoot(),
    })
    expect(config).toMatchObject({
      mode: 'live',
      bindHost: '127.0.0.1',
      hmrHost: '127.0.0.1',
      allowedOrigin: 'http://127.0.0.1:5190',
      backendOrigin: 'http://127.0.0.1:5290',
      workspaceId: 'default',
      trustTailnetHttp: true,
      sync: undefined,
    })
  })

  it('pins backend to 127.0.0.1 and rejects the unsupported backend-host override', () => {
    const { path } = makeTokenFile()
    expect(() => resolveStandaloneDeploymentConfig({
      env: {
        BORING_MAIL_DEPLOYMENT_MODE: 'live',
        BORING_MAIL_OWNER_TOKEN_FILE: path,
        BORING_MAIL_BIND_HOST: '127.0.0.1',
        BORING_MAIL_HMR_HOST: '127.0.0.1',
        BORING_MAIL_ALLOWED_ORIGIN: 'http://127.0.0.1:5190',
        BORING_MAIL_TRUST_TAILNET_HTTP: '1',
        BORING_MAIL_BACKEND_HOST: '127.0.0.2',
      },
      backendPort: 5290,
      defaultVitePort: 5190,
      defaultWorkspaceRoot: temporaryRoot(),
    })).toThrow(/BACKEND_HOST.*unsupported/)
  })

  it('requires explicit temporary fixture root, loopback topology, no Tailscale trust, and sync disabled', () => {
    const { path } = makeTokenFile()
    const fixtureRoot = temporaryRoot()
    const config = resolveStandaloneDeploymentConfig({
      env: {
        BORING_MAIL_DEPLOYMENT_MODE: 'fixture',
        BORING_MAIL_OWNER_TOKEN_FILE: path,
        BORING_MAIL_BIND_HOST: '127.0.0.1',
        BORING_MAIL_HMR_HOST: '127.0.0.1',
        BORING_MAIL_ALLOWED_ORIGIN: 'http://127.0.0.1:5190',
        BORING_MAIL_FIXTURE_ROOT: fixtureRoot,
      },
      backendPort: 5290,
      defaultVitePort: 5190,
      defaultWorkspaceRoot: process.cwd(),
    })
    expect(config).toMatchObject({
      mode: 'fixture',
      bindHost: '127.0.0.1',
      hmrHost: '127.0.0.1',
      allowedOrigin: 'http://127.0.0.1:5190',
      backendOrigin: 'http://127.0.0.1:5290',
      workspaceRoot: fixtureRoot,
      trustTailnetHttp: false,
      sync: false,
      mailRuntime: {
        productDbPath: join(fixtureRoot, '.boring-mail', 'fixture', 'product', 'mail.db'),
        msgvaultDbPath: join(fixtureRoot, '.boring-mail', 'fixture', 'msgvault', 'msgvault.db'),
      },
    })
    const auth = createStandaloneHostAuth(config)
    expect(auth.viteServer.host).toBe('127.0.0.1')
    auth.dispose()
  })

  it.each([
    ['missing fixture root', () => ({})],
    ['default HOME-like root', () => ({ BORING_MAIL_FIXTURE_ROOT: process.cwd() })],
    ['tailnet trust', () => ({ BORING_MAIL_FIXTURE_ROOT: temporaryRoot(), BORING_MAIL_TRUST_TAILNET_HTTP: '1' })],
    ['MSGVAULT_HOME', () => ({ BORING_MAIL_FIXTURE_ROOT: temporaryRoot(), MSGVAULT_HOME: temporaryRoot() })],
    ['MSGVAULT_DB_PATH', () => ({ BORING_MAIL_FIXTURE_ROOT: temporaryRoot(), MSGVAULT_DB_PATH: join(temporaryRoot(), 'msgvault.db') })],
    ['non-loopback bind', () => ({ BORING_MAIL_FIXTURE_ROOT: temporaryRoot(), BORING_MAIL_BIND_HOST: '100.64.0.2', BORING_MAIL_HMR_HOST: '100.64.0.2', BORING_MAIL_ALLOWED_ORIGIN: 'http://100.64.0.2:5190' })],
  ])('rejects fixture %s ambiguity', (_label, overrideFactory) => {
    const { path } = makeTokenFile()
    expect(() => {
      const config = resolveStandaloneDeploymentConfig({
        env: {
          BORING_MAIL_DEPLOYMENT_MODE: 'fixture',
          BORING_MAIL_OWNER_TOKEN_FILE: path,
          BORING_MAIL_BIND_HOST: '127.0.0.1',
          BORING_MAIL_HMR_HOST: '127.0.0.1',
          BORING_MAIL_ALLOWED_ORIGIN: 'http://127.0.0.1:5190',
          ...overrideFactory(),
        },
        backendPort: 5290,
        defaultVitePort: 5190,
        defaultWorkspaceRoot: process.cwd(),
      })
      createStandaloneHostAuth(config).dispose()
    }).toThrow()
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

  it('fails closed for missing, oversized, malformed, noncanonical, invalid UTF-8, and wrong-euid token files', () => {
    const root = temporaryRoot()
    expect(() => readVerifiedTokenFile(join(root, 'missing.token'))).toThrow()

    const oversized = join(root, 'oversized.token')
    writeFileSync(oversized, 'A'.repeat(257), { mode: 0o600 })
    expect(() => readVerifiedTokenFile(oversized)).toThrow(/1\.\.256/)

    const malformed = join(root, 'malformed.token')
    writeFileSync(malformed, 'not+base64url', { mode: 0o600 })
    expect(() => readVerifiedTokenFile(malformed)).toThrow(/base64url/)

    const noncanonical = join(root, 'noncanonical.token')
    writeFileSync(noncanonical, 'A', { mode: 0o600 })
    expect(() => readVerifiedTokenFile(noncanonical)).toThrow(/canonical/)

    const invalidUtf8 = join(root, 'invalid-utf8.token')
    writeFileSync(invalidUtf8, Buffer.from([0xff]), { mode: 0o600 })
    expect(() => readVerifiedTokenFile(invalidUtf8)).toThrow(/UTF-8/)

    const wrongUid = makeTokenFile(root).path
    const originalGeteuid = process.geteuid
    if (typeof originalGeteuid !== 'function') throw new Error('test requires process.geteuid')
    try {
      Object.defineProperty(process, 'geteuid', { value: () => originalGeteuid() + 1, configurable: true })
      expect(() => readVerifiedTokenFile(wrongUid)).toThrow(/effective uid/)
    } finally {
      Object.defineProperty(process, 'geteuid', { value: originalGeteuid, configurable: true })
    }
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

  it('rejects a resolved Vite host override such as the old --host 0.0.0.0 dev script', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'site'), { recursive: true })
    writeFileSync(join(root, 'site', 'index.html'), '<title>synthetic</title>', 'utf8')
    const { path } = makeTokenFile(root)
    const auth = createStandaloneHostAuth(topology(path))
    await expect(createViteServer({
      configFile: false,
      root: join(root, 'site'),
      logLevel: 'silent',
      plugins: [...auth.plugins],
      server: { ...auth.viteServer, host: '0.0.0.0' },
    })).rejects.toThrow(/resolved Vite HTTP topology/)
    auth.dispose()
  })

  it('requires exact injected proof, exact origin, CSRF, default workspace, and mail-read capability', async () => {
    const { path } = makeTokenFile()
    const auth = createStandaloneHostAuth(topology(path))
    const headers = bridgeHeaders()

    await expect(auth.browserAuthPolicy.resolve({
      callerClass: 'browser',
      definition: bridgeDefinition(),
      workspaceId: 'default',
      request: { method: 'POST', headers },
    })).resolves.toMatchObject({ context: { callerClass: 'browser', workspaceId: 'default' } })

    for (const allowedAskUserCapability of BORING_MAIL_PRESERVED_ASK_USER_BROWSER_CAPABILITIES) {
      await expect(auth.browserAuthPolicy.resolve({
        callerClass: 'browser',
        definition: bridgeDefinition([allowedAskUserCapability], `ask-user.v1.${allowedAskUserCapability.split(':')[1]}`),
        workspaceId: 'default',
        request: { method: 'POST', headers },
      })).resolves.toMatchObject({ context: { callerClass: 'browser', workspaceId: 'default' } })
    }

    for (const bad of [
      { headers: { ...headers, origin: 'http://127.0.0.2:5190' }, message: 'origin' },
      { headers: { ...headers, 'x-csrf-token': '' }, message: 'CSRF' },
      { headers: { ...headers, [BORING_MAIL_PROXY_PROOF_HEADER]: Buffer.alloc(32, 8).toString('base64url') }, message: 'proof' },
      { workspaceId: 'boring-mail', message: 'workspace' },
      { definition: bridgeDefinition(['workspace.files']), message: 'capability' },
      { definition: bridgeDefinition(['ask-user:request'], 'ask-user.v1.request'), message: 'ask-user-request' },
      { definition: bridgeDefinition(['ask-user:transcript.read'], 'ask-user.v1.transcript'), message: 'ask-user-transcript' },
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

  it('rejects browser bridge auth after dispose or HTTP close before zeroed proof can authenticate', async () => {
    const root = temporaryRoot()
    const { path } = makeTokenFile(root)
    const disposed = createStandaloneHostAuth(topology(path))
    disposed.dispose()
    await expect(disposed.browserAuthPolicy.resolve({
      callerClass: 'browser',
      definition: bridgeDefinition(),
      workspaceId: 'default',
      request: { method: 'POST', headers: bridgeHeaders(0) },
    })).rejects.toThrow()

    mkdirSync(join(root, 'site'), { recursive: true })
    writeFileSync(join(root, 'site', 'index.html'), '<title>synthetic</title>', 'utf8')
    const closed = createStandaloneHostAuth(topology(path))
    const vite = await createViteServer({
      configFile: false,
      root: join(root, 'site'),
      logLevel: 'silent',
      server: closed.viteServer,
      plugins: [...closed.plugins],
    })
    viteServers.push(vite)
    await vite.close()
    viteServers.splice(viteServers.indexOf(vite), 1)
    await expect(closed.browserAuthPolicy.resolve({
      callerClass: 'browser',
      definition: bridgeDefinition(),
      workspaceId: 'default',
      request: { method: 'POST', headers: bridgeHeaders(0) },
    })).rejects.toThrow()
  })

  it('round-trips preserved Ask User browser capability over the real HTTP bridge and denies unpreserved capabilities', async () => {
    const root = temporaryRoot()
    const { path } = makeTokenFile(root)
    const auth = createStandaloneHostAuth(topology(path))
    const plugin: WorkspaceServerPlugin = {
      id: 'synthetic-ask-user-bridge',
      contentDigest: 'synthetic-ask-user-bridge-v1',
      workspaceBridgeHandlers: [
        trustedSyntheticHandler('ask-user.v1.pending', ['ask-user:pending']),
        trustedSyntheticHandler('ask-user.v1.transcript', ['ask-user:transcript.read']),
      ],
    }
    const app = await createWorkspaceAgentServer({
      workspaceRoot: root,
      appRoot: root,
      mode: 'local',
      logger: false,
      externalPlugins: false,
      installPluginAuthoring: false,
      plugins: [plugin],
      defaultPluginPackages: [],
      workspaceBridge: { browserAuthPolicy: auth.browserAuthPolicy },
    })
    workspaceServers.push(app)

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/workspace-bridge/call',
      headers: { ...bridgeHeaders(), 'content-type': 'application/json' },
      payload: { op: 'ask-user.v1.pending', input: {}, requestId: 'redacted-pending' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(JSON.parse(accepted.body)).toMatchObject({ ok: true, output: { status: 'ok' } })

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/workspace-bridge/call',
      headers: { ...bridgeHeaders(), 'content-type': 'application/json' },
      payload: { op: 'ask-user.v1.transcript', input: {}, requestId: 'redacted-transcript' },
    })
    expect(denied.statusCode).toBe(403)
    expect(JSON.parse(denied.body)).toMatchObject({ ok: false, error: { code: 'BRIDGE_CAPABILITY_DENIED' } })
    auth.dispose()
  })
})
