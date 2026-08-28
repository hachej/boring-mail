import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { TextDecoder } from 'node:util'
import { createBrowserBridgeAuthPolicy, type BridgeAuthPolicy, type BridgeAuthPolicyInput } from '@hachej/boring-workspace/server'
import type { Plugin, ServerOptions, ViteDevServer } from 'vite'

const MAX_TOKEN_FILE_BYTES = 256
const MAX_TAILSCALE_STATUS_BYTES = 64 * 1024
const AUTH_USERNAME = 'boring-mail'
const OWNER_WORKSPACE_ID = 'default'
const MAIL_READ_CAPABILITY = 'boring-mail:inbox:read'
const PROOF_HEADER = 'x-boring-mail-proxy-proof'
const PRINCIPAL_HEADER = 'x-boring-mail-proxy-principal'
const BASE64URL = /^[A-Za-z0-9_-]+$/
const BASIC_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])
const LIVE_PATH_ENV = ['BORING_MAIL_LIVE_DATA_DIR', 'BORING_MAIL_MSGVAULT_PATH'] as const
const FIXTURE_PATH_ENV = ['BORING_MAIL_FIXTURE_ROOT'] as const
const utf8 = new TextDecoder('utf-8', { fatal: true })

export { AUTH_USERNAME as BORING_MAIL_BASIC_USERNAME, MAIL_READ_CAPABILITY as BORING_MAIL_READ_CAPABILITY, OWNER_WORKSPACE_ID as BORING_MAIL_WORKSPACE_ID, PRINCIPAL_HEADER as BORING_MAIL_PROXY_PRINCIPAL_HEADER, PROOF_HEADER as BORING_MAIL_PROXY_PROOF_HEADER }

export type StandaloneDeploymentMode = 'live' | 'fixture'

export interface StandaloneDeploymentConfig {
  mode: StandaloneDeploymentMode
  tokenFile: string
  bindHost: string
  hmrHost: string
  allowedOrigin: string
  backendOrigin: string
  trustTailnetHttp: boolean
  workspaceId: typeof OWNER_WORKSPACE_ID
}

export interface ResolveStandaloneDeploymentOptions {
  env?: NodeJS.ProcessEnv
  backendPort: number
  defaultVitePort: number
}

export interface StandaloneHostAuthOptions extends Omit<StandaloneDeploymentConfig, 'mode' | 'workspaceId'> {
  mode?: StandaloneDeploymentMode
  workspaceId?: typeof OWNER_WORKSPACE_ID
  readTailscaleStatus?: () => string
  trustedProof?: Buffer
}

export interface ValidatedStandaloneHostAuth {
  plugins: readonly [Plugin, Plugin]
  browserAuthPolicy: BridgeAuthPolicy
  proofHeader: typeof PROOF_HEADER
  principalHeader: typeof PRINCIPAL_HEADER
  viteServer: ServerOptions
  dispose(): void
}

interface TailscaleStatus {
  BackendState?: unknown
  Self?: { Online?: unknown; TailscaleIPs?: unknown }
}

interface ExpectedViteTopology {
  host: string
  port: number
  origin: string
  backendOrigin: string
  proxyPaths: readonly string[]
}

function fail(message: string): never {
  throw new Error(`boring-mail standalone host auth refused configuration: ${message}`)
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) fail(`${name} is required`)
  return value
}

function forbiddenEnv(env: NodeJS.ProcessEnv, names: readonly string[], mode: StandaloneDeploymentMode): void {
  for (const name of names) {
    if (env[name]?.trim()) fail(`${name} is not allowed in ${mode} mode`)
  }
}

export function resolveStandaloneDeploymentConfig({ env = process.env, backendPort, defaultVitePort }: ResolveStandaloneDeploymentOptions): StandaloneDeploymentConfig {
  const modeText = env.BORING_MAIL_DEPLOYMENT_MODE?.trim()
  if (modeText !== 'live' && modeText !== 'fixture') fail('BORING_MAIL_DEPLOYMENT_MODE must be exactly live or fixture')
  const mode = modeText
  if (mode === 'live') forbiddenEnv(env, FIXTURE_PATH_ENV, mode)
  else forbiddenEnv(env, LIVE_PATH_ENV, mode)

  const tokenFile = requiredEnv(env, 'BORING_MAIL_OWNER_TOKEN_FILE')
  const bindHost = requiredEnv(env, 'BORING_MAIL_BIND_HOST')
  const hmrHost = requiredEnv(env, 'BORING_MAIL_HMR_HOST')
  const allowedOrigin = requiredEnv(env, 'BORING_MAIL_ALLOWED_ORIGIN')
  const backendHost = env.BORING_MAIL_BACKEND_HOST?.trim() || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(backendHost)) fail('BORING_MAIL_BACKEND_HOST must be an explicit loopback IP')
  if (!Number.isSafeInteger(backendPort) || backendPort < 1 || backendPort > 65_535) fail('backend port must be a valid TCP port')
  if (!Number.isSafeInteger(defaultVitePort) || defaultVitePort < 1 || defaultVitePort > 65_535) fail('Vite port must be a valid TCP port')

  const origin = new URL(allowedOrigin)
  const originPort = Number(origin.port)
  if (originPort !== defaultVitePort) fail('BORING_MAIL_ALLOWED_ORIGIN port must match PORT/VITE port')

  return {
    mode,
    tokenFile,
    bindHost,
    hmrHost,
    allowedOrigin,
    backendOrigin: `http://${backendHost}:${backendPort}`,
    trustTailnetHttp: env.BORING_MAIL_TRUST_TAILNET_HTTP?.trim() === '1',
    workspaceId: OWNER_WORKSPACE_ID,
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL.test(value)) fail('token must be one unpadded base64url value')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) fail('token must use canonical unpadded base64url')
  return decoded
}

export function readVerifiedTokenFile(tokenFile: string): Buffer {
  const requested = resolve(tokenFile)
  const canonicalParent = realpathSync(dirname(requested))
  const canonicalPath = join(canonicalParent, basename(requested))
  const before = lstatSync(canonicalPath, { bigint: true })
  if (!before.isFile()) fail('token path is not a regular file')
  const fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (before.dev !== opened.dev || before.ino !== opened.ino) fail('token path changed while opening')
    if (!opened.isFile()) fail('token descriptor is not a regular file')
    if (opened.nlink !== 1n) fail('token file must have exactly one hard link')
    if (typeof process.geteuid !== 'function') fail('effective uid is unavailable on this platform')
    if (opened.uid !== BigInt(process.geteuid())) fail('token file must belong to the current effective uid')
    if ((opened.mode & 0o7777n) !== 0o600n) fail('token file mode must be exactly 0600 with no special bits')
    if (opened.size < 1n || opened.size > BigInt(MAX_TOKEN_FILE_BYTES)) fail('token file must contain 1..256 bytes')

    const size = Number(opened.size)
    const bytes = Buffer.alloc(size)
    if (readSync(fd, bytes, 0, size, 0) !== size) fail('token file changed while reading')
    if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) fail('token file grew while reading')
    const after = fstatSync(fd, { bigint: true })
    if (after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) {
      fail('token descriptor changed while reading')
    }

    let value: string
    try {
      value = utf8.decode(bytes)
    } catch {
      fail('token file is not valid UTF-8')
    } finally {
      bytes.fill(0)
    }
    if (value.trim() !== value || /\s/u.test(value)) fail('token file must not contain whitespace')
    const token = decodeBase64Url(value)
    if (token.byteLength < 32) {
      token.fill(0)
      fail('token must decode to at least 32 bytes')
    }
    return token
  } finally {
    closeSync(fd)
  }
}

export function readBoundedTailscaleStatus(): string {
  return execFileSync('tailscale', ['status', '--json'], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: MAX_TAILSCALE_STATUS_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function validateTailscaleSelf(statusText: string, bindHost: string): void {
  if (Buffer.byteLength(statusText, 'utf8') > MAX_TAILSCALE_STATUS_BYTES) fail('tailscale status exceeded 64 KiB')
  let status: TailscaleStatus
  try {
    status = JSON.parse(statusText) as TailscaleStatus
  } catch {
    fail('tailscale status was not valid JSON')
  }
  const ips = status.Self?.TailscaleIPs
  if (status.BackendState !== 'Running' || status.Self?.Online !== true ||
      !Array.isArray(ips) || !ips.every((value) => typeof value === 'string' && isIP(value) !== 0)) {
    fail('tailscale self status was not current and usable')
  }
  if (!ips.includes(bindHost)) fail('bind host is not an exact current local Tailscale IP')
}

function validateTopology(options: StandaloneHostAuthOptions): {
  viteServer: ServerOptions
  expected: Readonly<ExpectedViteTopology>
} {
  if ((options.workspaceId ?? OWNER_WORKSPACE_ID) !== OWNER_WORKSPACE_ID) fail('workspace owner must be default')
  if (isIP(options.bindHost) === 0 || options.bindHost === '0.0.0.0' || options.bindHost === '::') {
    fail('bind host must be one explicit IP address')
  }
  if (options.hmrHost !== options.bindHost) fail('HMR host must exactly match the explicit bind host')

  let origin: URL
  let backend: URL
  try {
    origin = new URL(options.allowedOrigin)
    backend = new URL(options.backendOrigin)
  } catch {
    fail('allowed and backend origins must be absolute URLs')
  }
  const originPort = Number(origin.port)
  if (!Number.isSafeInteger(originPort) || originPort < 1 || originPort > 65_535) fail('allowed origin must have an explicit valid port')
  if (origin.origin !== options.allowedOrigin || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.hostname !== options.bindHost) {
    fail('allowed origin must be one exact origin on the bind host')
  }
  if (backend.origin !== options.backendOrigin || backend.protocol !== 'http:' || backend.username || backend.password ||
      backend.pathname !== '/' || backend.search || backend.hash ||
      !LOOPBACK_HOSTS.has(backend.hostname) || !backend.port) {
    fail('backend must be one exact HTTP origin on an explicit loopback IP and port')
  }
  if (origin.protocol === 'http:') {
    if (!options.trustTailnetHttp) fail('tailnet HTTP requires explicit trust')
    validateTailscaleSelf((options.readTailscaleStatus ?? readBoundedTailscaleStatus)(), options.bindHost)
  } else if (origin.protocol === 'https:') {
    fail('HTTPS is not modeled; use exact trusted tailnet HTTP or add modeled TLS first')
  } else {
    fail('allowed origin must use HTTP over trusted tailnet')
  }

  const proxyPaths = Object.freeze(['/api/boring-mail', '/api/v1'] as const)
  const expected = Object.freeze<ExpectedViteTopology>({
    host: options.bindHost,
    port: originPort,
    origin: options.allowedOrigin,
    backendOrigin: options.backendOrigin,
    proxyPaths,
  })
  const viteServer: ServerOptions = {
    host: expected.host,
    port: expected.port,
    strictPort: true,
    cors: false,
    origin: expected.origin,
    hmr: { overlay: true },
    ws: { host: expected.host, port: expected.port, clientPort: expected.port },
    proxy: Object.fromEntries(expected.proxyPaths.map((path) => [path, expected.backendOrigin])),
  }
  return { viteServer, expected }
}

function assertResolvedViteTopology(server: ServerOptions, expected: Readonly<ExpectedViteTopology>): void {
  if (server.host !== expected.host || server.port !== expected.port || server.strictPort !== true ||
      server.cors !== false || server.origin !== expected.origin || server.https !== undefined) {
    fail('resolved Vite HTTP topology differs from the validated server object')
  }
  const ws = server.ws
  if (!ws || typeof ws !== 'object' || ws.host !== expected.host || ws.port !== expected.port ||
      ws.clientPort !== expected.port || ws.server !== undefined) {
    fail('resolved Vite websocket topology differs from the validated server object')
  }

  const proxy = server.proxy ?? {}
  const actualKeys = Object.keys(proxy).sort()
  if (actualKeys.join('\n') !== expected.proxyPaths.join('\n')) {
    fail('resolved Vite proxy routes differ from the validated server object')
  }
  for (const path of expected.proxyPaths) {
    const actualEntry = proxy[path]
    if (typeof actualEntry !== 'string' || actualEntry !== expected.backendOrigin) {
      fail(`resolved Vite proxy target differs for ${path}`)
    }
  }
}

function hookOrder(plugin: Plugin): 'pre' | 'post' | undefined {
  const hook = plugin.configureServer
  return typeof hook === 'object' && hook !== null && (hook.order === 'pre' || hook.order === 'post')
    ? hook.order
    : undefined
}

function assertAuthIsFirstConfigureHook(plugins: readonly Plugin[], auth: Plugin): void {
  const self = plugins.indexOf(auth)
  if (self < 0) fail('host-auth pre-auth plugin is missing from resolved plugins')
  for (const [index, plugin] of plugins.entries()) {
    if (plugin === auth || plugin.configureServer === undefined) continue
    const order = hookOrder(plugin)
    if (order === 'pre' || (order !== 'post' && index < self)) {
      fail('host-auth pre-auth plugin must be the first resolved configureServer hook')
    }
  }
}

function assertFinalizerIsLastConfigureHook(plugins: readonly Plugin[], finalizer: Plugin): void {
  const self = plugins.indexOf(finalizer)
  if (self < 0) fail('host-auth finalizer is missing from resolved plugins')
  for (const [index, plugin] of plugins.entries()) {
    if (plugin === finalizer || plugin.configureServer === undefined) continue
    const order = hookOrder(plugin)
    if (order === 'post' || (order !== 'pre' && index > self)) {
      fail('host-auth finalizer must be the last resolved configureServer hook')
    }
  }
}

function firstHeader(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function stripClientAuthorityHeaders(request: IncomingMessage): void {
  for (const name of Object.keys(request.headers)) {
    if (name === 'authorization' || name === 'proxy-authorization' ||
        /^x-boring-mail-(?:proxy-)?(?:proof|principal)(?:-|$)/i.test(name)) {
      delete request.headers[name]
    }
  }
}

function parseBasicToken(header: string | undefined): { username: string; token: Buffer } | null {
  if (!header) return null
  const match = /^Basic ([^\s]+)$/i.exec(header)
  if (!match || !BASIC_BASE64.test(match[1])) return null
  const payload = Buffer.from(match[1], 'base64')
  if (payload.toString('base64') !== match[1]) return null
  let decoded: string
  try {
    decoded = utf8.decode(payload)
  } catch {
    return null
  } finally {
    payload.fill(0)
  }
  const colon = decoded.indexOf(':')
  if (colon < 0) return null
  const username = decoded.slice(0, colon)
  const password = decoded.slice(colon + 1)
  if (!BASE64URL.test(password)) return null
  const token = Buffer.from(password, 'base64url')
  if (token.toString('base64url') !== password) {
    token.fill(0)
    return null
  }
  return { username, token }
}

function authorize(request: IncomingMessage, expectedToken: Buffer, trustedProof: Buffer): boolean {
  const credentials = parseBasicToken(typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : undefined)
  stripClientAuthorityHeaders(request)
  if (!credentials) return false
  const usernameBytes = Buffer.from(credentials.username, 'utf8')
  const expectedUsername = Buffer.from(AUTH_USERNAME, 'utf8')
  const usernameMatches = usernameBytes.byteLength === expectedUsername.byteLength &&
    timingSafeEqual(usernameBytes, expectedUsername)
  const tokenMatches = credentials.token.byteLength === expectedToken.byteLength &&
    timingSafeEqual(credentials.token, expectedToken)
  usernameBytes.fill(0)
  expectedUsername.fill(0)
  credentials.token.fill(0)
  if (!usernameMatches || !tokenMatches) return false
  request.headers[PROOF_HEADER] = trustedProof.toString('base64url')
  request.headers[PRINCIPAL_HEADER] = 'owner'
  return true
}

function rejectHttp(response: ServerResponse): void {
  response.statusCode = 401
  response.setHeader('WWW-Authenticate', 'Basic realm="Boring Mail", charset="UTF-8"')
  response.setHeader('Cache-Control', 'no-store')
  response.end('Unauthorized\n')
}

function installUpgradeGate(
  server: ViteDevServer,
  expectedToken: Buffer,
  trustedProof: Buffer,
  isDisposed: () => boolean,
): () => void {
  const httpServer = server.httpServer
  if (!httpServer) fail('Vite HTTP server is required to gate HMR upgrades')
  const delegated = httpServer.rawListeners('upgrade')
  httpServer.removeAllListeners('upgrade')
  const gate = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (isDisposed() || !authorize(request, expectedToken, trustedProof)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Boring Mail"\r\nConnection: close\r\n\r\n')
      return
    }
    for (const listener of delegated) {
      Reflect.apply(listener, httpServer, [request, socket, head])
    }
  }
  httpServer.on('upgrade', gate)
  let removed = false
  const remove = (): void => {
    if (removed) return
    removed = true
    httpServer.removeListener('upgrade', gate)
    httpServer.removeListener('close', remove)
    for (const listener of delegated) httpServer.on('upgrade', listener as never)
  }
  httpServer.once('close', remove)
  return remove
}

function proofMatches(input: BridgeAuthPolicyInput, trustedProof: Buffer): boolean {
  const proofText = firstHeader(input.request?.headers, PROOF_HEADER)
  const principal = firstHeader(input.request?.headers, PRINCIPAL_HEADER)
  if (principal !== 'owner' || !proofText || !BASE64URL.test(proofText)) return false
  const proof = Buffer.from(proofText, 'base64url')
  const ok = proof.byteLength === trustedProof.byteLength && timingSafeEqual(proof, trustedProof)
  proof.fill(0)
  return ok
}

function createStandaloneBrowserBridgeAuthPolicy(allowedOrigin: string, trustedProof: Buffer): BridgeAuthPolicy {
  return createBrowserBridgeAuthPolicy({
    allowedOrigins: [allowedOrigin],
    requireCsrfHeader: true,
    getPrincipal(input) {
      if (!proofMatches(input, trustedProof)) return null
      return { userId: 'boring-mail-owner', roles: ['owner'] }
    },
    authorizeWorkspace({ workspaceId }) {
      if (workspaceId !== OWNER_WORKSPACE_ID) return { allowed: false, capabilities: [] }
      return { allowed: true, role: 'owner', capabilities: [MAIL_READ_CAPABILITY] }
    },
  })
}

export function createStandaloneHostAuth(options: StandaloneHostAuthOptions): ValidatedStandaloneHostAuth {
  const { viteServer, expected } = validateTopology(options)
  const expectedToken = readVerifiedTokenFile(options.tokenFile)
  const trustedProof = options.trustedProof ? Buffer.from(options.trustedProof) : randomBytes(32)
  if (trustedProof.byteLength < 32) {
    expectedToken.fill(0)
    trustedProof.fill(0)
    fail('trusted backend proof must contain at least 32 random bytes')
  }
  let disposed = false
  let secretsCleared = false
  const clearSecrets = (): void => {
    if (secretsCleared) return
    secretsCleared = true
    expectedToken.fill(0)
    trustedProof.fill(0)
  }
  const authPlugin: Plugin = {
    name: 'boring-mail-host-auth:pre-auth',
    enforce: 'pre',
    configureServer(server) {
      server.httpServer?.once('close', clearSecrets)
      server.middlewares.use((request, response, next) => {
        if (disposed || !authorize(request, expectedToken, trustedProof)) {
          rejectHttp(response)
          return
        }
        next()
      })
    },
  }
  const finalizerPlugin: Plugin = {
    name: 'boring-mail-host-auth:finalizer',
    enforce: 'post',
    configResolved(config) {
      assertResolvedViteTopology(config.server, expected)
      assertAuthIsFirstConfigureHook(config.plugins, authPlugin)
      assertFinalizerIsLastConfigureHook(config.plugins, finalizerPlugin)
      Object.freeze(config.plugins)
    },
    configureServer(server) {
      assertResolvedViteTopology(server.config.server, expected)
      assertAuthIsFirstConfigureHook(server.config.plugins, authPlugin)
      assertFinalizerIsLastConfigureHook(server.config.plugins, finalizerPlugin)
      return () => {
        assertResolvedViteTopology(server.config.server, expected)
        assertAuthIsFirstConfigureHook(server.config.plugins, authPlugin)
        assertFinalizerIsLastConfigureHook(server.config.plugins, finalizerPlugin)
        installUpgradeGate(server, expectedToken, trustedProof, () => disposed)
      }
    },
  }
  return {
    plugins: Object.freeze([authPlugin, finalizerPlugin]) as readonly [Plugin, Plugin],
    browserAuthPolicy: createStandaloneBrowserBridgeAuthPolicy(options.allowedOrigin, trustedProof),
    proofHeader: PROOF_HEADER,
    principalHeader: PRINCIPAL_HEADER,
    viteServer,
    dispose() {
      disposed = true
      clearSecrets()
    },
  }
}
