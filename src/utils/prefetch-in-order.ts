/** Start a walk's independent reads in parallel, consume them in order. */

import pLimit from "p-limit";

const PREFETCH_CONCURRENCY = 32;

/** `read(item)` for every item, started now, at most {@link PREFETCH_CONCURRENCY} at a time. */
export function prefetchInOrder<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R>[] {
  const limit = pLimit(PREFETCH_CONCURRENCY);
  return items.map((item) => {
    const pending = limit(() => read(item));
    pending.catch(() => {});
    return pending;
  });
}
