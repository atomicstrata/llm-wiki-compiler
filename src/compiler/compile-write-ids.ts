/**
 * Report the IDs committed by a derived-page pass through the existing compile
 * write adapter. Keep the adapter as the single observable write/fault-injection
 * seam, and exclude floor-refused pages from downstream embedding reconciliation.
 */

import { applyCompilePageWritesLocked, type CompilePageWrite } from "./compile-write.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";

/** Apply a derived pass, optionally persisting approved IDs before writes; return committed IDs. */
export async function applyCompilePageWritesWithIdsLocked(
  root: string,
  items: CompilePageWrite[],
  beforeApply?: (pageIds: PageId[]) => Promise<void>,
): Promise<PageId[]> {
  const options = beforeApply ? {
    beforeApply: (allowed: CompilePageWrite[]) => beforeApply(allowed.map(item => qualifiedPageId(item.namespace, item.slug))),
  } : undefined;
  const { skipped } = await applyCompilePageWritesLocked(root, items, options);
  const blocked = new Set(skipped.map(({ item }) => item));
  return items.filter(item => !blocked.has(item)).map(item => qualifiedPageId(item.namespace, item.slug));
}
