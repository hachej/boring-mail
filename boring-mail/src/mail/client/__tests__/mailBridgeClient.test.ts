import { describe, expect, it, vi } from 'vitest'
import { MailBridgeBrowserClient, MailBridgeClientError } from '../mailBridgeClient'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('MailBridgeBrowserClient', () => {
  it('safeParses authoritative list outputs and rejects invalid bridge output', async () => {
    const client = new MailBridgeBrowserClient({
      apiBaseUrl: '',
      fetch: vi.fn(async () => jsonResponse(200, { ok: true, output: { status: 'surprise' } })) as never,
    })
    await expect(client.listInbox()).rejects.toThrow(/schema validation/)
  })

  it('passes an already-aborted signal to fetch', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true)
      throw new DOMException('aborted', 'AbortError')
    })
    const client = new MailBridgeBrowserClient({ apiBaseUrl: '', fetch: fetchImpl as never })
    await expect(client.call('boring-mail.v1.inbox.list', {}, { signal: controller.signal })).rejects.toThrow(/aborted/)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('propagates mid-flight aborts to the fetch signal', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      controller.abort()
    }))
    const client = new MailBridgeBrowserClient({ apiBaseUrl: '', fetch: fetchImpl as never })
    await expect(client.call('boring-mail.v1.inbox.list', {}, { signal: controller.signal })).rejects.toThrow(/aborted/)
  })

  it('calls onAuthError only for 401 and 403 HTTP responses', async () => {
    const onAuthError = vi.fn()
    const fetchImpl = vi.fn(async () => jsonResponse(401, { ok: false }))
    const client = new MailBridgeBrowserClient({ apiBaseUrl: '', fetch: fetchImpl as never, onAuthError })
    await expect(client.call('boring-mail.v1.inbox.list', {})).rejects.toBeInstanceOf(MailBridgeClientError)
    expect(onAuthError).toHaveBeenCalledWith(401)

    fetchImpl.mockResolvedValueOnce(jsonResponse(500, { ok: false }))
    await expect(client.call('boring-mail.v1.inbox.list', {})).rejects.toBeInstanceOf(MailBridgeClientError)
    expect(onAuthError).toHaveBeenCalledTimes(1)
  })
})
