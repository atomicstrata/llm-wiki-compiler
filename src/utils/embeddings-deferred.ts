/**
 * Preserve the last usable cache when the retry scheduler defers replacement.
 * Migration still discovers stale pages on the next run: these records retain
 * their original hashes and timestamps, never the live page's newer metadata.
 * The caller supplies only a same-backend store and eligible discovered ids;
 * deleted/private pages and vectors from another backend must stay pruned.
 */
import type { EmbeddingStoreV3, ParsedStore } from "./embeddings-store.js";
import { assertEmbeddingStoreValid } from "./embeddings-validate.js";
import type { PageId } from "./page-id.js";

/** Restore page and chunk records together, without upgrading unverifiable legacy vectors. */
export function retainDeferredEmbeddings(
  preservable: ParsedStore | null,
  migrated: EmbeddingStoreV3,
  deferred: Set<PageId>,
): void {
  if (!preservable || preservable.version !== 3 || deferred.size === 0) return;
  if (preservable.store.model !== migrated.model) return;
  try {
    assertEmbeddingStoreValid(preservable.store);
  } catch {
    return; // Never undo migration's integrity rejection.
  }
  const old = preservable.store as unknown as EmbeddingStoreV3;
  migrated.entries = [
    ...migrated.entries.filter(entry => !deferred.has(entry.pageId)),
    ...old.entries.filter(entry => deferred.has(entry.pageId)),
  ];
  migrated.chunks = [
    ...(migrated.chunks ?? []).filter(entry => !deferred.has(entry.pageId)),
    ...(old.chunks ?? []).filter(entry => deferred.has(entry.pageId)),
  ];
}
