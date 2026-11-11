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

import type { LegacyLocalReads } from "./legacy-local-reads.js";
import { oncePer } from "../utils/pass-memo.js";
import { prefetchInOrder } from "../utils/prefetch-in-order.js";

/** {@link LegacyLocalReads} whose confined page reads are shared, plus a prefetch. */
export interface ReadOncePages extends LegacyLocalReads {
  /** Read `<relDir>/<slug>.md` for every slug in parallel, settling once all have. Never rejects. */
  prefetchPages(relDir: string, slugs: readonly string[]): Promise<void>;
}

/** Wrap `reads` for one read-only pass. See the file header for the contract. */
export function readOncePages(reads: LegacyLocalReads): ReadOncePages {
  const readConfinedPage = oncePer((relDir: string, slug: string) => `${relDir}\0${slug}`,
    (relDir, slug) => reads.readConfinedPage(relDir, slug));
  return {
    ...reads,
    readConfinedPage,
    prefetchPages: async (relDir, slugs) => {
      await Promise.allSettled(prefetchInOrder(slugs, (slug) => readConfinedPage(relDir, slug)));
    },
  };
}
