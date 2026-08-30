// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createWorkspaceBridgeRegistry, type WorkspaceBridgeCallContext } from '@hachej/boring-workspace/server'
import { WorkspaceBridgeErrorCode } from '@hachej/boring-workspace/shared'
import { createBoringMailBridgeHandlers, BORING_MAIL_READ_CAPABILITY } from '../mailBridgeHandlers.ts'
import { createMailThreadTargetAuthority } from '../mailTargetAuthority.ts'
import { ProductStoreError, type UnifiedInboxPage, type UnifiedThreadDetail } from '../../store/product/types.ts'

function context(overrides: Partial<WorkspaceBridgeCallContext> = {}): WorkspaceBridgeCallContext {
  return {
    callerClass: 'browser',
    workspaceId: 'default',
    capabilities: [BORING_MAIL_READ_CAPABILITY],
    actor: { actorKind: 'human', performedBy: { label: 'owner' } },
    ...overrides,
  }
}

function page(): UnifiedInboxPage {
  return {
    items: [{
      messageId: 42,
      conversationId: 7,
      sourceId: 8,
      sourceIdentifier: 'private@example.invalid',
      rfc822MessageId: '<private@example.invalid>',
      senderName: 'Sender',
      senderEmail: 'sender@example.invalid',
      subject: 'Subject',
      snippet: 'Snippet',
      messageAt: '2026-08-30 10:00:00+00:00',
      unread: true,
      hasAttachments: false,
      coalesced: false,
      copyCount: 1,
      textTruncated: { senderName: false, senderEmail: false, subject: false, snippet: false },
    }],
    nextCursor: null,
  }
}

function threadDetail(): UnifiedThreadDetail {
  return {
    selectedMessageId: 42,
    subject: 'Subject',
    messages: [{
      messageId: 42,
      selected: true,
      sentAt: '2026-08-30 10:00:00+00:00',
      sender: { name: 'Sender', email: 'sender@example.invalid' },
      recipients: [{ type: 'to', name: 'Recipient', email: 'recipient@example.invalid' }],
      bodyText: 'plain text',
      bodyUnavailable: false,
      bodyTruncated: false,
      attachments: [],
      metadataTruncated: false,
    }],
    historyTruncated: false,
    selectedOutsideRecentWindow: false,
    replyCapability: { allowed: false, reason: 'drafts_not_in_scope' },
  }
}

function registryFor(read: (operation: (store: any) => Promise<unknown>) => Promise<unknown>, authority = createMailThreadTargetAuthority(Buffer.alloc(32, 3))) {
  const registry = createWorkspaceBridgeRegistry({ ownerWorkspaceId: 'default' })
  for (const contribution of createBoringMailBridgeHandlers({ runtime: { read } as never, targetAuthority: authority })) {
    registry.registerHandler(contribution.definition, contribution.handler)
  }
  return { registry, authority }
}

describe('Boring Mail bridge handlers', () => {
  it('register exact browser-only definitions with capability, size, timeout, and no idempotency', () => {
    const { registry } = registryFor(async () => ({ status: 'unavailable' }))
    const list = registry.getDefinition('boring-mail.v1.inbox.list')!
    const thread = registry.getDefinition('boring-mail.v1.thread.get')!
    expect(list.callerClassesAllowed).toEqual(['browser'])
    expect(thread.callerClassesAllowed).toEqual(['browser'])
    expect(list.requiredCapabilities).toEqual([BORING_MAIL_READ_CAPABILITY])
    expect(thread.requiredCapabilities).toEqual([BORING_MAIL_READ_CAPABILITY])
    expect(list.idempotencyPolicy).toBe('none')
    expect(thread.idempotencyPolicy).toBe('none')
    expect(list.timeoutMs).toBe(10_000)
    expect(thread.timeoutMs).toBe(10_000)
    expect(list.maxInputBytes).toBe(4 * 1024)
    expect(thread.maxInputBytes).toBe(1024)
    expect(list.maxOutputBytes).toBe(512 * 1024)
    expect(thread.maxOutputBytes).toBe(512 * 1024)
  })

  it('enforces caller class, capability, workspace, schema, and input size through the registry', async () => {
    const { registry } = registryFor(async () => ({ status: 'unavailable' }))
    await expect(registry.call({ op: 'boring-mail.v1.inbox.list', input: {} }, context({ callerClass: 'server' }))).resolves.toMatchObject({ ok: false, error: { code: WorkspaceBridgeErrorCode.CallerNotAllowed } })
    await expect(registry.call({ op: 'boring-mail.v1.inbox.list', input: {} }, context({ capabilities: [] }))).resolves.toMatchObject({ ok: false, error: { code: WorkspaceBridgeErrorCode.CapabilityDenied } })
    await expect(registry.call({ op: 'boring-mail.v1.inbox.list', input: {} }, context({ workspaceId: 'other' }))).resolves.toMatchObject({ ok: false, error: { code: WorkspaceBridgeErrorCode.ResourceScopeDenied } })
    await expect(registry.call({ op: 'boring-mail.v1.inbox.list', input: { limit: 999 } }, context())).resolves.toMatchObject({ ok: false, error: { code: WorkspaceBridgeErrorCode.SchemaInvalid } })
    await expect(registry.call({ op: 'boring-mail.v1.thread.get', input: { target: 'x'.repeat(2_000) } }, context())).resolves.toMatchObject({ ok: false, error: { code: WorkspaceBridgeErrorCode.InputTooLarge } })
  })

  it('maps invalid storage message ids during runtime.read so corruption becomes unavailable', async () => {
    const corruptPage = page()
    corruptPage.items[0].messageId = 0
    const { registry } = registryFor(async (operation) => {
      try {
        return { status: 'ok', value: await operation({ listUnifiedInbox: async () => corruptPage }) }
      } catch (error) {
        if (error instanceof ProductStoreError && error.code === 'corrupt_data') return { status: 'unavailable' }
        throw error
      }
    })
    await expect(registry.call({ op: 'boring-mail.v1.inbox.list', input: {} }, context())).resolves.toMatchObject({ ok: true, output: { status: 'unavailable' } })
  })

  it('maps list output through the frozen contract and excludes store authority fields', async () => {
    const { registry } = registryFor(async (operation) => ({ status: 'ok', value: await operation({ listUnifiedInbox: async () => page() }) }))
    const response = await registry.call({ op: 'boring-mail.v1.inbox.list', input: { limit: 1 } }, context())
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unexpected bridge failure')
    expect(response.output).toMatchObject({ status: 'ok', items: [{ subject: 'Subject' }], nextCursor: null })
    const item = (response.output as any).items[0]
    expect(item.target).toMatch(/^bm1\.42\./u)
    expect(item.conversationId).toBeUndefined()
    expect(item.sourceIdentifier).toBeUndefined()
    expect(JSON.stringify(response.output).length).toBeLessThan(512 * 1024)
  })

  it('maps stale and unavailable list statuses without leaking errors', async () => {
    const stale = registryFor(async () => ({ status: 'stale_cursor' })).registry
    const unavailable = registryFor(async () => ({ status: 'unavailable' })).registry
    await expect(stale.call({ op: 'boring-mail.v1.inbox.list', input: {} }, context())).resolves.toMatchObject({ ok: true, output: { status: 'stale_cursor' } })
    await expect(unavailable.call({ op: 'boring-mail.v1.inbox.list', input: {} }, context())).resolves.toMatchObject({ ok: true, output: { status: 'unavailable' } })
  })

  it('verifies canonical HMAC targets for thread reads and maps malformed/tampered/old targets to not_found', async () => {
    const { registry, authority } = registryFor(async (operation) => ({ status: 'ok', value: await operation({ getUnifiedThread: async ({ messageId }: { messageId: number }) => messageId === 42 ? threadDetail() : null }) }))
    const target = authority.mint(42)
    await expect(registry.call({ op: 'boring-mail.v1.thread.get', input: { target } }, context())).resolves.toMatchObject({ ok: true, output: { status: 'ok', thread: { target } } })
    await expect(registry.call({ op: 'boring-mail.v1.thread.get', input: { target: target.replace(/.$/u, 'A') } }, context())).resolves.toMatchObject({ ok: true, output: { status: 'not_found' } })
    const old = createMailThreadTargetAuthority(Buffer.alloc(32, 4)).mint(42)
    await expect(registry.call({ op: 'boring-mail.v1.thread.get', input: { target: old } }, context())).resolves.toMatchObject({ ok: true, output: { status: 'not_found' } })
  })

  it('returns unavailable for typed store read failures and keeps statuses closed', async () => {
    const { registry } = registryFor(async () => ({ status: 'unavailable' }))
    await expect(registry.call({ op: 'boring-mail.v1.thread.get', input: { target: createMailThreadTargetAuthority(Buffer.alloc(32, 3)).mint(42) } }, context())).resolves.toMatchObject({ ok: true, output: { status: 'unavailable' } })
    const failing = registryFor(async () => { throw new ProductStoreError('rpc_timeout', 'no pii') }).registry
    await expect(failing.call({ op: 'boring-mail.v1.inbox.list', input: {} }, context())).resolves.toMatchObject({ ok: false })
  })
})
