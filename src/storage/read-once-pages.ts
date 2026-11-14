/** Confined page reads shared and prefetched within ONE read-only pass. */

import type { LegacyLocalReads } from "./legacy-local-reads.js";
import { oncePer } from "../utils/pass-memo.js";
import { prefetchInOrder } from "../utils/prefetch-in-order.js";

/** {@link LegacyLocalReads} whose confined page reads are shared, plus a prefetch. */
export interface ReadOncePages extends LegacyLocalReads {
  prefetchPages(relDir: string, slugs: readonly string[]): Promise<void>;
}

/** Wrap `reads` for one read-only pass. */
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
