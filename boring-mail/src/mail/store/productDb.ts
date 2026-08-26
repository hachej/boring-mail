/** Public storage boundary: asynchronous RPC backed by one dedicated worker. */
export { openMailStore } from './product/MailStore.js'
export type {
  AsyncOutboxStore,
  MailStore,
  MailStoreOpenOptions,
  MailStoreWorkerFactory,
  WorkerTransport,
} from './product/MailStore.js'
export type { MailStoreWorkerConfig } from './product/mailStoreProtocol.js'
export { ProductStoreError } from './product/types.js'
export type {
  AccountInput,
  ApprovedOutbox,
  AttentionItem,
  AttentionKind,
  CancelledOutbox,
  ClaimedOutbox,
  ClaimedSend,
  ComposeDraftInput,
  DispatchedOutbox,
  DraftInput,
  DraftRecord,
  FailedOutbox,
  HumanDecisionOutbox,
  MailAttachment,
  OutboxRecord,
  OutboxStatus,
  PendingOutbox,
  ProductStoreErrorCode,
  RejectedOutbox,
  ReplyDraftInput,
  ResolvedReplyTarget,
  SendContent,
  SendSnapshot,
  SentOutbox,
  StaleOutbox,
  UnknownOutbox,
} from './product/types.js'
