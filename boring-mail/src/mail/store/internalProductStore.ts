/**
 * Worker-side synchronous implementation.
 *
 * This path is internal/test-only. Runtime callers must use the async MailStore
 * facade exported by productDb.ts so DatabaseSync never runs on the host loop.
 */
export { ProductStore, openProductStore } from './product/ProductStore.js'
export { PRODUCT_SCHEMA_VERSION } from './product/migrations.js'
export { draftContentDigest, projectSendContent, sendSnapshotDigest } from './product/sendSnapshot.js'
export { ProductStoreError } from './product/types.js'
export type * from './product/types.js'
