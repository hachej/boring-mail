import { defineTrustedDomainBridgeHandler, type WorkspaceBridgeHandlerContribution } from '@hachej/boring-workspace/server'
import {
  mailBridgeListContract,
  mailBridgeListInputContract,
  mailBridgeListOutputContract,
  mapUnifiedInboxPageToBrowserList,
  type BrowserInboxListOutput,
} from '../bridge/mailBridgeListContract.ts'
import {
  mailBridgeThreadContract,
  mailBridgeThreadInputContract,
  mailBridgeThreadOutputContract,
  mapUnifiedThreadToBrowserThread,
  type BrowserThreadGetOutput,
} from '../bridge/mailBridgeThreadContract.ts'
import type { UnifiedInboxOptions } from '../store/product/types.ts'
import type { MailRuntimeLifecycleManager } from './mailRuntimeLifecycle.ts'
import type { MailThreadTargetAuthority } from './mailTargetAuthority.ts'

export const BORING_MAIL_READ_CAPABILITY = 'boring-mail:inbox:read'
export const BORING_MAIL_BRIDGE_OUTPUT_MAX_BYTES = 512 * 1024
export const BORING_MAIL_LIST_INPUT_MAX_BYTES = 4 * 1024
export const BORING_MAIL_THREAD_INPUT_MAX_BYTES = 1024
export const BORING_MAIL_BRIDGE_TIMEOUT_MS = 10_000

export interface MailBridgeHandlerOptions {
  runtime: MailRuntimeLifecycleManager
  targetAuthority: MailThreadTargetAuthority
}

function assertListOutput(output: BrowserInboxListOutput): BrowserInboxListOutput {
  const parsed = mailBridgeListOutputContract.safeParse(output)
  if (!parsed.success) throw new Error('mail list handler produced invalid output')
  return parsed.data
}

function assertThreadOutput(output: BrowserThreadGetOutput): BrowserThreadGetOutput {
  const parsed = mailBridgeThreadOutputContract.safeParse(output)
  if (!parsed.success) throw new Error('mail thread handler produced invalid output')
  return parsed.data
}

export function createBoringMailBridgeHandlers({ runtime, targetAuthority }: MailBridgeHandlerOptions): WorkspaceBridgeHandlerContribution[] {
  const list = defineTrustedDomainBridgeHandler({
    op: mailBridgeListContract.op,
    version: 1,
    owner: 'boring-mail',
    callerClassesAllowed: ['browser'],
    requiredCapabilities: [BORING_MAIL_READ_CAPABILITY],
    inputSchema: mailBridgeListInputContract,
    outputSchema: mailBridgeListOutputContract,
    timeoutMs: BORING_MAIL_BRIDGE_TIMEOUT_MS,
    maxInputBytes: BORING_MAIL_LIST_INPUT_MAX_BYTES,
    maxOutputBytes: BORING_MAIL_BRIDGE_OUTPUT_MAX_BYTES,
    idempotencyPolicy: 'none',
    handler: async ({ input }) => {
      const parsed = mailBridgeListInputContract.safeParse(input)
      if (!parsed.success) throw new Error('mail list input failed schema validation')
      const read = await runtime.read(async (store) => {
        const page = await store.listUnifiedInbox(parsed.data as UnifiedInboxOptions)
        return mapUnifiedInboxPageToBrowserList(page, (id) => targetAuthority.mint(id))
      })
      if (read.status === 'stale_cursor') return assertListOutput({ status: 'stale_cursor' })
      if (read.status === 'unavailable') return assertListOutput({ status: 'unavailable' })
      return assertListOutput(read.value)
    },
  })

  const thread = defineTrustedDomainBridgeHandler({
    op: mailBridgeThreadContract.op,
    version: 1,
    owner: 'boring-mail',
    callerClassesAllowed: ['browser'],
    requiredCapabilities: [BORING_MAIL_READ_CAPABILITY],
    inputSchema: mailBridgeThreadInputContract,
    outputSchema: mailBridgeThreadOutputContract,
    timeoutMs: BORING_MAIL_BRIDGE_TIMEOUT_MS,
    maxInputBytes: BORING_MAIL_THREAD_INPUT_MAX_BYTES,
    maxOutputBytes: BORING_MAIL_BRIDGE_OUTPUT_MAX_BYTES,
    idempotencyPolicy: 'none',
    handler: async ({ input }) => {
      const parsed = mailBridgeThreadInputContract.safeParse(input)
      if (!parsed.success) throw new Error('mail thread input failed schema validation')
      const messageId = targetAuthority.verify(parsed.data.target)
      if (messageId === null) return assertThreadOutput({ status: 'not_found' })
      const read = await runtime.read(async (store) => {
        const detail = await store.getUnifiedThread({ messageId })
        return mapUnifiedThreadToBrowserThread(detail, parsed.data.target)
      })
      if (read.status !== 'ok') return assertThreadOutput({ status: 'unavailable' })
      return assertThreadOutput(read.value)
    },
  })

  return [list, thread]
}
