/** @file Post-write refresh for trusted OKF imports (links, index, MOC, embeddings). */
import { resolveAndApplyLinks } from "../compiler/resolver.js";
import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { slugFromPageId, type PageId } from "../utils/page-id.js";

/**
 * Rebuild derived artifacts after writing imported pages live.
 *
 * The embeddings refresh routes through the SHARED
 * {@link refreshEmbeddingsDrainingPending} — the same drain compile and
 * `review approve` use — so an OKF import UNIONS the imported page-ids into any
 * prior-pending marker and settles it per-id. Without this, a workflow of OKF
 * imports + refresh that never runs a plain compile would never drain
 * accumulated pending compile-embeddings, leaving them stale indefinitely. The
 * import already holds the project lock across this call (runOkfImport:
 * acquireLock → writeAll → refreshAfterImport, inside the try, before the
 * finally releaseLock), so the shared drain's lock-free Core is correct (the
 * self-locking wrapper would deadlock under the held lock).
 *
 * @param root - Project root path.
 * @param pageIds - Qualified page ids of the imported pages (`<namespace>/<slug>`).
 */
export async function refreshAfterImport(root: string, pageIds: PageId[]): Promise<void> {
  // resolveAndApplyLinks operates on bare slugs (default concepts/queries
  // pipeline). The OKF import already holds the project lock (runOkfImport), so
  // this routes through the lock-free resolution seam.
  const slugs = pageIds.map(slugFromPageId);
  await resolveAndApplyLinks(root, slugs, slugs);
  await generateIndex(root);
  await generateMOC(root);
  // Union the imported page-ids into the shared pending-marker drain (preserves
  // the existing changed-id set; the drain adds prior-pending ids on top).
  await refreshEmbeddingsDrainingPending(root, pageIds);
}
