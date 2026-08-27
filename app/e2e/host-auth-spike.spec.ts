import { test, expect } from '@playwright/test'
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { createHostAuthSpike, type ValidatedHostAuthSpike } from '../spikes/hostAuth.spike'

let root: string
let origin: string
let token: string
let vite: ViteDevServer
let backend: Server
let spike: ValidatedHostAuthSpike
let backendRequestCount = 0

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return address.port
}

async function reservePort(): Promise<number> {
  const server = createHttpServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'boring-mail-host-auth-playwright-'))
  const site = join(root, 'site')
  mkdirSync(site)
  writeFileSync(join(site, 'index.html'), [
    '<!doctype html>',
    '<title>synthetic authenticated owner</title>',
    '<main data-testid="owner-surface">synthetic owner surface</main>',
    '<script type="module" src="/client.ts"></script>',
  ].join('\n'), 'utf8')
  writeFileSync(join(site, 'client.ts'), 'if (import.meta.hot) import.meta.hot.accept()\n', 'utf8')
  token = randomBytes(32).toString('base64url')
  const tokenFile = join(root, 'owner.token')
  writeFileSync(tokenFile, token, { mode: 0o600 })

  backend = createHttpServer((_request, response) => {
    backendRequestCount += 1
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true }))
  })
  const backendPort = await listen(backend)
  const vitePort = await reservePort()
  origin = `http://127.0.0.1:${vitePort}`
  spike = createHostAuthSpike({
    tokenFile,
    bindHost: '127.0.0.1',
    hmrHost: '127.0.0.1',
    allowedOrigin: origin,
    backendOrigin: `http://127.0.0.1:${backendPort}`,
    trustTailnetHttp: true,
    readTailscaleStatus: () => JSON.stringify({
      BackendState: 'Running',
      Self: { Online: true, TailscaleIPs: ['127.0.0.1'] },
    }),
    trustedProof: Buffer.alloc(32, 9),
  })
  vite = await createViteServer({
    configFile: false,
    root: site,
    logLevel: 'silent',
    plugins: [spike.plugin],
    server: spike.viteServer,
  })
  await vite.listen()
})

test.afterAll(async () => {
  spike?.dispose()
  await vite?.close()
  await new Promise<void>((resolve) => backend?.close(() => resolve()))
  if (root) rmSync(root, { recursive: true, force: true })
})

test('unauthenticated browser cannot load the owner surface or proxy', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const response = await page.goto(origin)
  expect(response?.status()).toBe(401)
  await expect(page.locator('body')).toContainText('Unauthorized')
  const proxy = await context.request.get(`${origin}/api/v1/probe`)
  expect(proxy.status()).toBe(401)
  expect(backendRequestCount).toBe(0)
  expect(vite.ws.clients.size).toBe(0)
  await context.close()
})

test('Playwright HTTP credentials load assets, proxy, and authenticated Vite HMR', async ({ browser }) => {
  const context = await browser.newContext({
    httpCredentials: { username: 'boring-mail', password: token },
  })
  const page = await context.newPage()
  const response = await page.goto(origin)
  expect(response?.status()).toBe(200)
  await expect(page.getByTestId('owner-surface')).toHaveText('synthetic owner surface')
  await expect.poll(() => vite.ws.clients.size).toBeGreaterThan(0)
  const proxy = await context.request.get(`${origin}/api/v1/probe`)
  expect(proxy.status()).toBe(200)
  expect(backendRequestCount).toBe(1)
  await context.close()
})
