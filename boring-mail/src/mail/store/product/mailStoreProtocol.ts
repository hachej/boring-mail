import type {
  AccountInput,
  ApprovedOutbox,
  AttentionItem,
  CancelledOutbox,
  ClaimedOutbox,
  DispatchedOutbox,
  DraftInput,
  DraftRecord,
  FailedOutbox,
  HumanDecisionOutbox,
  OutboxRecord,
  RejectedOutbox,
  ReadSourceReconcileResult,
  SentOutbox,
  UnifiedInboxOptions,
  UnifiedInboxPage,
  UnknownOutbox,
} from './types.js'

export interface MailStoreWorkerConfig {
  productDbPath: string
  msgvaultDbPath?: string
}

export interface MailStoreMethods {
  upsertAccount: (input: AccountInput) => void
  saveDraft: (input: DraftInput, requestedId?: string) => DraftRecord
  getDraft: (id: string) => DraftRecord | null
  reconcileMsgvaultReadSources: () => ReadSourceReconcileResult
  setReadSourceEnabled: (sourceId: number, enabled: boolean) => void
  listUnifiedInbox: (options?: UnifiedInboxOptions) => UnifiedInboxPage
  getOutbox: (id: string) => OutboxRecord | null
  listAttention: (openOnly?: boolean) => AttentionItem[]
  enqueue: (draftId: string, operationKey: string) => OutboxRecord
  issueApprovalCapability: (id: string, sessionId: string, ttlMs?: number) => string
  approve: (id: string, token: string, sessionId: string) => ApprovedOutbox
  reject: (id: string) => RejectedOutbox
  claim: (id: string, workerId: string, leaseMs?: number) => ClaimedOutbox
  claimNext: (workerId: string, leaseMs?: number) => ClaimedOutbox | null
  markDispatched: (id: string, workerId: string, preDispatchHistoryId: string) => DispatchedOutbox
  markSent: (id: string, workerId: string, providerMessageId: string) => SentOutbox
  markFailed: (id: string, workerId: string, code: string, detail: string) => FailedOutbox
  markUnknown: (id: string, workerId: string, detail: string, deadlineMs?: number) => UnknownOutbox
  cancel: (id: string) => CancelledOutbox
  recoverExpired: () => UnknownOutbox[]
  dueReconciliations: (limit?: number) => UnknownOutbox[]
  reconciliationFound: (id: string, providerMessageId: string) => SentOutbox
  reconciliationMiss: (id: string, backoffMs: number) => UnknownOutbox | HumanDecisionOutbox
  keepWaiting: (id: string, durationMs?: number) => UnknownOutbox
  markHumanSent: (id: string) => SentOutbox
  retry: (id: string, operationKey: string) => OutboxRecord
  close: () => void
}

export type MailStoreMethod = keyof MailStoreMethods
export type RpcRequest = {
  [M in MailStoreMethod]: { id: number; method: M; args: Parameters<MailStoreMethods[M]> }
}[MailStoreMethod]
export interface SerializedError {
  name: string
  message: string
  code?: string
  stack?: string
}
export type RpcResponse =
  | { type: 'ready' }
  | { type: 'ready'; error: SerializedError }
  | { type: 'response'; id: number; value: unknown }
  | { type: 'response'; id: number; error: SerializedError }

export type RpcHandlers = {
  [M in MailStoreMethod]: (
    ...args: Parameters<MailStoreMethods[M]>
  ) => ReturnType<MailStoreMethods[M]> | Promise<ReturnType<MailStoreMethods[M]>>
}
