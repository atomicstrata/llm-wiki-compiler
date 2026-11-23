/**
 * @file src/compiler/limited-until-failure.ts
 * @description The one stop-and-drain rule every limited fan-out of a compile
 * follows: ordinary extraction, ordinary page generation, and the batch
 * compile's extraction and generation batches.
 *
 * pLimit keeps draining its queue after a task fails, and a plain
 * `Promise.all` rejects at the first failure while its siblings still run. A
 * compile built on that would keep making model calls after the provider had
 * already failed fatally, and could reach a checkpoint, a store close or its
 * lock release while a call was still outstanding. Here the first failure
 * stops admission (a queued item never starts its work), every item already
 * admitted settles, and only then does the ORIGINAL first thrown value escape.
 *
 * Internal to the compiler: no public barrel exports it.
 */

import type { LimitFunction } from "p-limit";

/**
 * Run `work` for each item under `limit`, stopping at the first failure.
 *
 * The limit may be shared with other fan-outs (its cap is theirs too). The
 * first value thrown by `work` is kept by identity, even a falsy one; items
 * not yet started then skip `work` entirely. The returned promise settles only
 * after every admitted `work` call has settled, so no task of this call is
 * still running when it rejects, and no rejection is left unhandled. A value
 * `work` resolves with, including one carrying a recoverable error, is a
 * success and does not stop admission.
 *
 * @param limit - The concurrency pool the work runs under.
 * @param items - The inputs, in the order their results are returned.
 * @param work - The per-item work.
 * @returns Every result, in input order, when no item failed.
 * @throws The first value thrown by `work`, after all admitted work settled.
 */
export async function runLimitedUntilFailure<T, R>(
  limit: LimitFunction,
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  let failure: { error: unknown } | undefined;
  const settled = await Promise.all(items.map((item) => limit(async () => {
    if (failure) return undefined;
    try {
      return { value: await work(item) };
    } catch (error) {
      failure ??= { error };
      return undefined;
    }
  })));
  if (failure) throw failure.error;
  // With no failure every item ran to a result, so none is undefined.
  return settled.map((result) => (result as { value: R }).value);
}
