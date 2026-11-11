/**
 * @file src/storage/read-once-pages.ts
 * @description Confined page reads shared and prefetched within ONE read-only pass.
 *
 * Compile's link passes walk every concept page in order, one confined read at
 * a time, and a pass can walk the same directory twice. Each confined read is
 * a chain of dependent syscalls, so a sequential walk pays their full latency
 * per page. {@link readOncePages} wraps the reads for one pass:
 *
 * - every `readConfinedPage(dir, slug)` is made once, and later asks get the
 *   same promise (its result, or its rejection);
 * - `prefetchPages` starts a directory's reads in parallel, bounded, so the
 *   pass's own in-order loop then finds each page already read.
 *
 * The loop is unchanged, so results, warnings and failures still come in
 * listing order: prefetch never rejects, and a failed read rejects where the
 * loop reaches it. Use one wrapper per pass with no writes inside it; a
 * wrapper kept across a write would answer with the page as first read.
 */

import pLimit from "p-limit";
import type { ConfinedReadResult, LegacyLocalReads } from "./legacy-local-reads.js";

/** Page reads in flight at once: overlaps their latency without exhausting descriptors. */
const PREFETCH_CONCURRENCY = 32;

/** {@link LegacyLocalReads} whose confined page reads are shared, plus a prefetch. */
export interface ReadOncePages extends LegacyLocalReads {
  /** Start reading `<relDir>/<slug>.md` for every slug, in parallel. Never rejects. */
  prefetchPages(relDir: string, slugs: readonly string[]): Promise<void>;
}

/** Wrap `reads` for one read-only pass. See the file header for the contract. */
export function readOncePages(reads: LegacyLocalReads): ReadOncePages {
  const pages = new Map<string, Promise<ConfinedReadResult>>();
  const readConfinedPage = (relDir: string, slug: string): Promise<ConfinedReadResult> => {
    const key = `${relDir}\0${slug}`;
    if (!pages.has(key)) pages.set(key, reads.readConfinedPage(relDir, slug));
    return pages.get(key)!;
  };
  const limit = pLimit(PREFETCH_CONCURRENCY);
  return {
    ...reads,
    readConfinedPage,
    prefetchPages: async (relDir, slugs) => {
      await Promise.allSettled(slugs.map((slug) => limit(() => readConfinedPage(relDir, slug))));
    },
  };
}
