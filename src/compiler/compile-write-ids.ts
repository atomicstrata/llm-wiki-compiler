/**
 * Report the IDs committed by a derived-page pass through the existing compile
 * write adapter. Keep the adapter as the single observable write/fault-injection
 * seam, and exclude floor-refused pages from downstream embedding reconciliation.
 *
 * ONE BODY. {@link applyCompilePageWritesWithIdsWith} is handed the compile page
 * write as an explicit DOMAIN collaborator (not storage); the root
 * {@link applyCompilePageWritesWithIdsLocked} keeps its signature and passes the
 * incumbent `applyCompilePageWritesLocked`, called at call time with exactly
 * the arguments it always got, so its module spies still see every call.
 */

import {
  applyCompilePageWritesLocked,
  compileWriteDirectory,
  type BeforeCompilePageWrites,
  type CompilePageWrite,
  type SkippedWrite,
} from "./compile-write.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";

/** The compile page write a derived pass goes through. Local: `applyCompilePageWritesLocked(root, items, options)`. */
export type CompilePageWritePass = (
  root: string,
  items: CompilePageWrite[],
  options: { beforeApply: BeforeCompilePageWrites } | undefined,
) => Promise<{ skipped: SkippedWrite[] }>;

/** Apply a derived pass, optionally persisting approved IDs before writes; return committed IDs. */
export async function applyCompilePageWritesWithIdsLocked(
  root: string,
  items: CompilePageWrite[],
  beforeApply?: (pageIds: PageId[]) => Promise<void>,
): Promise<PageId[]> {
  return applyCompilePageWritesWithIdsWith((at, writes, options) => applyCompilePageWritesLocked(at, writes, options), root, items, beforeApply);
}

/** THE ONE BODY of {@link applyCompilePageWritesWithIdsLocked}, over the page write it is handed. */
export async function applyCompilePageWritesWithIdsWith(
  writePages: CompilePageWritePass,
  root: string,
  items: CompilePageWrite[],
  beforeApply?: (pageIds: PageId[]) => Promise<void>,
): Promise<PageId[]> {
  const options = beforeApply ? {
    beforeApply: (allowed: CompilePageWrite[]) => beforeApply(allowed.map(item => qualifiedPageId(compileWriteDirectory(item), item.slug))),
  } : undefined;
  const { skipped } = await writePages(root, items, options);
  const blocked = new Set(skipped.map(({ item }) => item));
  return items.filter(item => !blocked.has(item)).map(item => qualifiedPageId(compileWriteDirectory(item), item.slug));
}
