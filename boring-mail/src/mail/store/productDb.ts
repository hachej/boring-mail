/**
 * Compile input for the public `@hachej/boring-mail/mail-store` export.
 * Consumers use that compiled package export so mailStoreWorker.js is adjacent;
 * application code must not import this source path directly.
 */
export { openMailStore } from './product/MailStore.js'
export type {
  AsyncOutboxStore,
  MailStore,
  MailStoreOpenOptions,
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
  UnifiedInboxItem,
  UnifiedInboxOptions,
  UnifiedInboxPage,
  UnknownOutbox,
} from './product/types.js'
