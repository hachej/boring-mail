import { DatabaseSync } from 'node:sqlite'
import {
  currentMsgvaultDataVersion,
  listUnifiedInboxInSnapshot,
  type UnifiedInboxCursorAuthority,
} from '../msgvaultAdapter.js'
import { readMsgvaultGmailReadSourceSnapshot } from '../msgvault/readSources.js'
import { ProductStore } from './ProductStore.js'
import { ProductStoreError, type ReadSourceReconcileResult, type UnifiedInboxOptions, type UnifiedInboxPage } from './types.js'

export interface MsgvaultSnapshotHooks {
  /** Deterministic WAL-race seam after catalog capture/reconcile and before projection. */
  afterCatalogCapture?: () => void
}

export function withMsgvaultReadSnapshot<T>(
  db: DatabaseSync,
  body: (snapshotDataVersion: number) => T,
): T {
  db.exec('BEGIN DEFERRED')
  try {
    const before = currentMsgvaultDataVersion(db)
    const value = body(before)
    db.exec('COMMIT')
    if (currentMsgvaultDataVersion(db) !== before) {
      throw new ProductStoreError('stale_cursor', 'msgvault changed while reading a snapshot')
    }
    return value
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  }
}

export function reconcileMsgvaultReadSourcesInSnapshot(
  db: DatabaseSync,
  productStore: ProductStore,
): ReadSourceReconcileResult {
  return withMsgvaultReadSnapshot(db, () =>
    productStore.reconcileMsgvaultReadSources(readMsgvaultGmailReadSourceSnapshot(db)))
}

export function listUnifiedInboxWithReconciledSnapshot(
  db: DatabaseSync,
  productStore: ProductStore,
  cursorAuthority: UnifiedInboxCursorAuthority,
  options: UnifiedInboxOptions | undefined,
  hooks: MsgvaultSnapshotHooks = {},
): UnifiedInboxPage {
  return withMsgvaultReadSnapshot(db, (snapshotDataVersion) => {
    productStore.reconcileMsgvaultReadSources(readMsgvaultGmailReadSourceSnapshot(db))
    hooks.afterCatalogCapture?.()
    return listUnifiedInboxInSnapshot(
      db,
      productStore.connectedInboxSources(),
      cursorAuthority,
      snapshotDataVersion,
      options,
    )
  })
}
