// @vitest-environment node
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http'
import { execFileSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createViteServer, type ServerOptions, type ViteDevServer } from 'vite'
import { createHostAuthSpike, readVerifiedTokenFile, type HostAuthSpikeOptions } from './hostAuth.spike'

const roots: string[] = []
const viteServers: ViteDevServer[] = []
const httpServers: Array<ReturnType<typeof createHttpServer>> = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'boring-mail-host-auth-spike-'))
  roots.push(root)
  return root
}

function makeTokenFile(root = temporaryRoot(), bytes = randomBytes(32)): { path: string; text: string } {
  const path = join(root, 'owner.token')
  const text = bytes.toString('base64url')
  writeFileSync(path, text, { mode: 0o600 })
  return { path, text }
}

function topology(tokenFile: string, port = 5190): HostAuthSpikeOptions {
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

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  httpServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return address.port
}

async function reservePort(): Promise<number> {
  const server = createHttpServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  httpServers.splice(httpServers.indexOf(server), 1)
  return port
}

function basic(token: string, username = 'boring-mail'): string {
  return `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`
}

async function websocketStatus(port: number, authorization?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('websocket handshake timed out'))
    }, 3_000)
    socket.once('error', reject)
    socket.once('connect', () => {
      const headers = [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: vite-hmr',
        ...(authorization ? [`Authorization: ${authorization}`] : []),
        '',
        '',
      ]
      socket.write(headers.join('\r\n'))
    })
    socket.on('data', (chunk) => {
      const firstLine = chunk.toString('utf8').split('\r\n', 1)[0]
      clearTimeout(timer)
      socket.destroy()
      resolve(firstLine)
    })
  })
}

afterEach(async () => {
  await Promise.allSettled(viteServers.splice(0).map((server) => server.close()))
  await Promise.allSettled(httpServers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verified owner token descriptor', () => {
  it('accepts one canonical whitespace-free 0600 base64url token of at least 32 bytes', () => {
    const { path } = makeTokenFile()
    const token = readVerifiedTokenFile(path)
    expect(token).toHaveLength(32)
    token.fill(0)
  })

  it('fails closed for unsafe mode, short token, whitespace, symlink, and hard link', () => {
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
  })

  it('rejects special mode bits and a FIFO without blocking', () => {
    const root = temporaryRoot()
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

describe('standalone topology validation', () => {
  it('accepts only an explicit trusted tailnet self IP, exact origin/HMR host, and loopback backend', () => {
    const { path } = makeTokenFile()
    const spike = createHostAuthSpike(topology(path))
    spike.dispose()
  })

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
    expect(() => createHostAuthSpike({ ...topology(path), ...override })).toThrow(/refused configuration/)
  })

  it('rejects stale, mismatched, malformed, or oversized tailscale status', () => {
    const { path } = makeTokenFile()
    const base = topology(path)
    for (const status of [
      JSON.stringify({ BackendState: 'Stopped', Self: { Online: true, TailscaleIPs: ['127.0.0.1'] } }),
      JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['127.0.0.1'] } }),
      JSON.stringify({ BackendState: 'Running', Self: { Online: 'yes', TailscaleIPs: ['127.0.0.1'] } }),
      JSON.stringify({ BackendState: 'Running', Self: { Online: true, TailscaleIPs: ['not-an-ip'] } }),
      JSON.stringify({ BackendState: 'Running', Self: { Online: true, TailscaleIPs: ['100.64.0.8'] } }),
      '{',
      ' '.repeat(65 * 1024),
    ]) {
      expect(() => createHostAuthSpike({ ...base, readTailscaleStatus: () => status })).toThrow(/refused configuration/)
    }
  })

  it('refuses resolved Vite config that diverges from the validated authoritative server object', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'index.html'), '<title>synthetic</title>', 'utf8')
    const { path } = makeTokenFile(root)
    const mismatches: Array<Partial<ServerOptions>> = [
      { cors: true },
      { host: '0.0.0.0' },
      { ws: { host: '0.0.0.0', port: 24_678, clientPort: 24_678 } },
      { proxy: { '/api/v1': 'http://127.0.0.1:5290', '/api/boring-mail': 'http://127.0.0.1:5291' } },
      { proxy: {
        '/api/v1': { target: 'http://127.0.0.1:5290' },
        '/api/boring-mail': { target: 'http://127.0.0.1:5290' },
      } },
    ]
    for (const mismatch of mismatches) {
      const spike = createHostAuthSpike(topology(path))
      await expect(createViteServer({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [...spike.plugins],
        server: { ...spike.viteServer, ...mismatch },
      })).rejects.toThrow(/resolved Vite .* topology|resolved Vite proxy target/)
      spike.dispose()
    }
  })

  it('reasserts topology after later configResolved and configureServer mutators', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'index.html'), '<title>synthetic</title>', 'utf8')
    const { path } = makeTokenFile(root)

    const wsSpike = createHostAuthSpike(topology(path))
    await expect(createViteServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: wsSpike.viteServer,
      plugins: [...wsSpike.plugins, {
        name: 'synthetic-late-ws-mutator',
        configResolved(config) {
          config.server.ws = { host: '0.0.0.0', port: 24_678, clientPort: 24_678 }
        },
      }],
    })).rejects.toThrow(/resolved Vite websocket topology/)
    wsSpike.dispose()

    const proxySpike = createHostAuthSpike(topology(path))
    await expect(createViteServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: proxySpike.viteServer,
      plugins: [...proxySpike.plugins, {
        name: 'synthetic-late-proxy-mutator',
        configureServer(server) {
          if (server.config.server.proxy) {
            server.config.server.proxy['/api/v1'] = 'http://127.0.0.1:5291'
          }
        },
      }],
    })).rejects.toThrow(/resolved Vite proxy target/)
    proxySpike.dispose()

    const returnedPostSpike = createHostAuthSpike(topology(path))
    await expect(createViteServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: returnedPostSpike.viteServer,
      plugins: [...returnedPostSpike.plugins, {
        name: 'synthetic-returned-post-mutator',
        configureServer(server) {
          return () => {
            if (server.config.server.proxy) {
              server.config.server.proxy['/api/v1'] = 'http://127.0.0.1:5291'
            }
            server.httpServer?.prependListener('upgrade', () => undefined)
          }
        },
      }],
    })).rejects.toThrow(/resolved Vite proxy target/)
    returnedPostSpike.dispose()

    const objectHookSpike = createHostAuthSpike(topology(path))
    await expect(createViteServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: objectHookSpike.viteServer,
      plugins: [...objectHookSpike.plugins, {
        name: 'synthetic-object-post-hook',
        configureServer: {
          order: 'post',
          handler(server) {
            return () => {
              server.httpServer?.prependListener('upgrade', () => undefined)
            }
          },
        },
      }],
    })).rejects.toThrow(/finalizer must be the last resolved configureServer hook/)
    objectHookSpike.dispose()
  })
})

describe('real Vite server auth spike', () => {
  it('gates assets, HMR upgrades, and proxy; consumes Basic and replaces spoofed proof', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'site'))
    writeFileSync(join(root, 'site', 'index.html'), '<!doctype html><title>synthetic auth spike</title>', 'utf8')
    const { path: tokenFile, text: token } = makeTokenFile(root)
    const backendRequests: IncomingHttpHeaders[] = []
    const backend = createHttpServer((request, response) => {
      backendRequests.push({ ...request.headers })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
    })
    const backendPort = await listen(backend)
    const vitePort = await reservePort()
    const spike = createHostAuthSpike({
      ...topology(tokenFile, vitePort),
      backendOrigin: `http://127.0.0.1:${backendPort}`,
    })
    let returnedPostUpgradeHits = 0
    const vite = await createViteServer({
      configFile: false,
      root: join(root, 'site'),
      logLevel: 'silent',
      plugins: [...spike.plugins, {
        name: 'synthetic-returned-post-upgrade-listener',
        configureServer(server) {
          return () => {
            server.httpServer?.prependListener('upgrade', () => { returnedPostUpgradeHits += 1 })
          }
        },
      }],
      server: spike.viteServer,
    })
    viteServers.push(vite)
    await vite.listen()

    const origin = `http://127.0.0.1:${vitePort}`
    const unauthenticatedPreflight = await fetch(`${origin}/`, { method: 'OPTIONS' })
    expect(unauthenticatedPreflight.status).toBe(401)
    const unauthenticatedAsset = await fetch(`${origin}/`)
    expect(unauthenticatedAsset.status).toBe(401)
    expect(unauthenticatedAsset.headers.get('www-authenticate')).toMatch(/^Basic /)

    const authenticatedAsset = await fetch(`${origin}/`, { headers: { authorization: basic(token) } })
    expect(authenticatedAsset.status).toBe(200)
    expect(await authenticatedAsset.text()).toContain('synthetic auth spike')

    const rejectedProxyPreflight = await fetch(`${origin}/api/v1/probe`, { method: 'OPTIONS' })
    expect(rejectedProxyPreflight.status).toBe(401)
    const rejectedProxy = await fetch(`${origin}/api/v1/probe`)
    expect(rejectedProxy.status).toBe(401)
    expect(backendRequests).toHaveLength(0)

    const acceptedProxy = await fetch(`${origin}/api/v1/probe`, {
      headers: {
        authorization: basic(token),
        'proxy-authorization': 'Basic attacker',
        'x-boring-mail-proxy-proof': 'attacker',
        'x-boring-mail-proxy-proof-extra': 'attacker',
        'x-boring-mail-principal-spoof': 'attacker',
      },
    })
    expect(acceptedProxy.status).toBe(200)
    expect(backendRequests).toHaveLength(1)
    const forwarded = backendRequests[0]
    expect(forwarded.authorization).toBeUndefined()
    expect(forwarded['proxy-authorization']).toBeUndefined()
    expect(forwarded['x-boring-mail-proxy-proof']).toBe(Buffer.alloc(32, 7).toString('base64url'))
    expect(forwarded['x-boring-mail-proxy-principal']).toBe('owner')
    expect(forwarded['x-boring-mail-proxy-proof-extra']).toBeUndefined()
    expect(forwarded['x-boring-mail-principal-spoof']).toBeUndefined()

    expect(await websocketStatus(vitePort)).toMatch(/^HTTP\/1\.1 401 /)
    expect(returnedPostUpgradeHits).toBe(0)
    expect(await websocketStatus(vitePort, basic(token))).toMatch(/^HTTP\/1\.1 101 /)
    expect(returnedPostUpgradeHits).toBe(1)

    spike.dispose()
    expect((await fetch(`${origin}/`, { headers: { authorization: basic(token) } })).status).toBe(401)
    expect(await websocketStatus(vitePort, basic(token))).toMatch(/^HTTP\/1\.1 401 /)
  }, 15_000)
})
