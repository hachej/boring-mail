import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  mailBridgeListContract,
  mailBridgeListOutputContract,
  type BrowserInboxListInput,
  type BrowserInboxListOutput,
} from '../bridge/mailBridgeListContract'
import {
  mailBridgeThreadContract,
  mailBridgeThreadOutputContract,
  type BrowserThreadGetInput,
  type BrowserThreadGetOutput,
} from '../bridge/mailBridgeThreadContract'

interface PluginProviderLikeProps {
  apiBaseUrl: string
  authHeaders?: Record<string, string>
  authScopeKey?: string
  onAuthError?: (statusCode: number) => void
  apiTimeout?: number
  children: ReactNode
}

export interface MailBridgeTransportOptions {
  apiBaseUrl: string
  authHeaders?: Record<string, string>
  authScopeKey?: string
  onAuthError?: (statusCode: number) => void
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface MailBridgeCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export class MailBridgeClientError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
    this.name = 'MailBridgeClientError'
  }
}

function bridgeUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/u, '')}/api/v1/workspace-bridge/call`
}

function requestId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  return `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function parseBridgeEnvelope(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MailBridgeClientError('mail bridge response was not an object')
  }
  if (!('ok' in payload) || payload.ok !== true) {
    const error = 'error' in payload && payload.error && typeof payload.error === 'object' &&
      !Array.isArray(payload.error) && 'message' in payload.error && typeof payload.error.message === 'string'
      ? payload.error.message
      : 'mail bridge call failed'
    throw new MailBridgeClientError(error)
  }
  if (!('output' in payload)) throw new MailBridgeClientError('mail bridge response omitted output')
  return payload.output
}

function parseListOutput(output: unknown): BrowserInboxListOutput {
  const parsed = mailBridgeListOutputContract.safeParse(output)
  if (!parsed.success) throw new MailBridgeClientError('mail bridge list output failed schema validation')
  return parsed.data
}

function parseThreadOutput(output: unknown): BrowserThreadGetOutput {
  const parsed = mailBridgeThreadOutputContract.safeParse(output)
  if (!parsed.success) throw new MailBridgeClientError('mail bridge thread output failed schema validation')
  return parsed.data
}

export class MailBridgeBrowserClient {
  readonly #options: MailBridgeTransportOptions

  constructor(options: MailBridgeTransportOptions) {
    this.#options = options
  }

  async call(op: string, input: unknown, options: MailBridgeCallOptions = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs ?? 30_000
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const abort = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await (this.#options.fetch ?? fetch)(bridgeUrl(this.#options.apiBaseUrl), {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': this.#options.authScopeKey || 'boring-mail',
          ...(this.#options.authHeaders ?? {}),
        },
        body: JSON.stringify({ op, input, requestId: requestId() }),
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.#options.onAuthError?.(response.status)
        throw new MailBridgeClientError('mail bridge HTTP request failed', response.status)
      }
      return parseBridgeEnvelope(await response.json())
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  async listInbox(input: BrowserInboxListInput = {}, options?: MailBridgeCallOptions): Promise<BrowserInboxListOutput> {
    return parseListOutput(await this.call(mailBridgeListContract.op, input, options))
  }

  async getThread(input: BrowserThreadGetInput, options?: MailBridgeCallOptions): Promise<BrowserThreadGetOutput> {
    return parseThreadOutput(await this.call(mailBridgeThreadContract.op, input, options))
  }
}

const MailBridgeClientContext = createContext<MailBridgeBrowserClient | null>(null)

export function BoringMailBridgeProvider(props: PluginProviderLikeProps) {
  const client = useMemo(() => new MailBridgeBrowserClient({
    apiBaseUrl: props.apiBaseUrl,
    authHeaders: props.authHeaders,
    authScopeKey: props.authScopeKey,
    onAuthError: props.onAuthError,
    timeoutMs: props.apiTimeout,
  }), [props.apiBaseUrl, props.authHeaders, props.authScopeKey, props.onAuthError, props.apiTimeout])
  return <MailBridgeClientContext.Provider value={client}>{props.children}</MailBridgeClientContext.Provider>
}

export function useBoringMailBridgeClient(): MailBridgeBrowserClient {
  const client = useContext(MailBridgeClientContext)
  if (!client) throw new MailBridgeClientError('Boring Mail bridge client provider is not installed')
  return client
}
