/**
 * @file src/utils/prefetch-in-order.ts
 * @description Start a walk's independent reads in parallel, consume them in order.
 *
 * Several whole-wiki walks read one page per step and do nothing else between
 * steps, so a sequential loop pays every read's full syscall latency in turn.
 * {@link prefetchInOrder} starts every read up front, a bounded number at a
 * time, and hands back their promises in input order. A caller that awaits
 * them in order sees each result, and the first failure, exactly where its
 * sequential loop did, so its own warnings and early returns are unchanged.
 * Use it only where the reads have no side effects and depend on nothing the
 * loop does between them.
 */

import pLimit from "p-limit";

/** Reads in flight at once: overlaps their latency without exhausting descriptors. */
const PREFETCH_CONCURRENCY = 32;

/**
 * `read(item)` for every item, started now, at most {@link PREFETCH_CONCURRENCY}
 * at a time. A failure surfaces only where its promise is awaited.
 */
export function prefetchInOrder<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R>[] {
  const limit = pLimit(PREFETCH_CONCURRENCY);
  return items.map((item) => {
    const pending = limit(() => read(item));
    // A loop that stops early never awaits the rest; keep their rejections handled.
    pending.catch(() => {});
    return pending;
  });
}
