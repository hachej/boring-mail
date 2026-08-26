// Product-owned state is isolated from msgvault's read-only archive.
export { openProductStore, ProductStore } from './product/ProductStore.js'
export { draftContentDigest, normalizeDraft, sendSnapshotDigest } from './product/sendSnapshot.js'
export { PRODUCT_SCHEMA_VERSION } from './product/migrations.js'
export {
  ProductStoreError,
  type AccountInput,
  type AttentionItem,
  type ClaimedSend,
  type DraftInput,
  type DraftRecord,
  type MailAttachment,
  type OutboxRecord,
  type OutboxStatus,
  type ProductStoreDependencies,
  type ReplyTarget,
  type SendSnapshot,
} from './product/types.js'
