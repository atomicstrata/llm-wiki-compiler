/**
 * @file src/compiler/batch/pages.ts
 * @description The BOUNDED page read of a batch compile: the incumbent
 * confined page read (the page's real path must be inside its directory; it
 * is opened without following a link, must be a regular file still bound to
 * that path), read through a bounded loop that never reads more than one
 * byte past the cap: a page above {@link MAX_PAGE_BYTES} refuses the run
 * (`compile_batch_page_too_large`) rather than being allocated. A page that
 * escapes or cannot be read is dropped exactly as the incumbent drops it.
 */

import path from "node:path";
import { readConfinedPageThrough } from "../../storage/disk-local-reads.js";
import type { ConfinedReadResult } from "../../storage/legacy-local-reads.js";
import { readBoundedBytes } from "../../utils/confined-read.js";
import { isInsideDir, safeRealpath } from "../../utils/path-confine.js";
import { BatchCompileError } from "./contracts.js";

/** The largest page a batch compile reads (it must also fit one run row when snapshotted). */
export const MAX_PAGE_BYTES = 960 * 1024;

/**
 * The largest index (`wiki/index.md`) a batch compile PUBLISHES and the
 * largest it READS as extraction context: one cap, so an index one batch
 * compile publishes is always one the next can read.
 */
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;

/** Read page `slug` of `relDir` in the project at `root`, confined and bounded by `cap` (default {@link MAX_PAGE_BYTES}). */
export async function readPageBounded(root: string, relDir: string, slug: string, cap = MAX_PAGE_BYTES): Promise<ConfinedReadResult> {
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return { dropped: "no-root" };
  const expectedDir = path.join(canonicalRoot, relDir);
  const real = await safeRealpath(path.join(expectedDir, `${slug}.md`));
  if (!real || !isInsideDir(real, expectedDir)) return { dropped: "escapes-dir" };
  // At most one byte past the cap is ever read, so a page growing under the open handle cannot be allocated whole.
  const read = await readConfinedPageThrough(real, expectedDir, (handle) => readBoundedBytes(handle, cap));
  if (read.kind !== "ok") return { dropped: "unreadable" };
  if (read.value.length > cap) throw new BatchCompileError("compile_batch_page_too_large", `${relDir}/${slug}.md is over the ${cap}-byte batch read cap`);
  return { content: read.value.toString("utf8") };
}

/** The content of page `slug`, or `""` when it is absent or dropped (the incumbent `readWikiPageContentOrWarn` shape, warning left to the caller). */
export async function pageContentBounded(root: string, relDir: string, slug: string): Promise<string> {
  const read = await readPageBounded(root, relDir, slug);
  return "content" in read ? read.content : "";
}
