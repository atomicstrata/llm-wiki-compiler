/**
 * @file src/scale/downgrade-barrier.ts
 * @description The scale-down's use of the shared retirement barrier
 * (`../segments/retire-barrier.ts`): published BEFORE the reader census and
 * held until the scale-down ends, so a reader registering after the census
 * refuses instead of opening a store about to be archived.
 *
 * A barrier whose owner is positively gone (a crashed earlier attempt) is
 * removed by identity first; a barrier whose owner may be running refuses.
 * A census finding a live or uncertain lease removes OUR barrier and refuses
 * (`scale_downgrade_readers_live`); nothing else was changed by it.
 */

import { readerCensus } from "../segments/reader-lease.js";
import { clearStaleRetireBarrier, publishRetireBarrier, removeRetireBarrier, retireBarrierState, retireFenceState } from "../segments/retire-barrier.js";
import { ScaleDowngradeError } from "./downgrade-contracts.js";

/** Publish this scale-down's barrier for `plan` on canonical `root` and take the census; returns its token. */
export async function holdBarrier(root: string, plan: string): Promise<string> {
  const state = await retireFenceState(root);
  if (state.kind === "blocking") throw new ScaleDowngradeError("scale_downgrade_readers_live", state.reason);
  if (state.kind === "stale") await clearStaleRetireBarrier(root);
  const token = await publishRetireBarrier(root, plan);
  let census: Awaited<ReturnType<typeof readerCensus>>;
  try { census = await readerCensus(root); } catch (error) {
    return censusFailed(root, token, error);
  }
  if (census.live.length > 0 || census.uncertain.length > 0) {
    await removeRetireBarrier(root, { token });
    throw new ScaleDowngradeError("scale_downgrade_readers_live", `${census.live.length} live and ${census.uncertain.length} uncertain reader lease(s) found; stop those readers and re-run`, { live: census.live, uncertain: census.uncertain });
  }
  return token;
}

/** A census that threw: release this token, then refuse typed with the census's cause and the release outcome (neither masks the other). */
async function censusFailed(root: string, token: string, error: unknown): Promise<never> {
  const cause = error instanceof Error ? error.message : String(error);
  const released = await removeRetireBarrier(root, { token }).then(() => "released", (failure: unknown) => `not released: ${failure instanceof Error ? failure.message : String(failure)}`);
  throw new ScaleDowngradeError("scale_downgrade_readers_live", `the reader census failed (${cause}); this attempt's barrier was ${released}`, { cause, barrier: released });
}

/** Remove this attempt's barrier, the one carrying `token` (nothing when there is none). */
export async function releaseBarrier(root: string, token: string): Promise<void> {
  if ((await retireBarrierState(root)).kind === "absent") return;
  await removeRetireBarrier(root, { token });
}

/**
 * Remove a barrier left by a crashed attempt of THIS scale-down (stale owner,
 * this plan, an interrupted publication included); the plan is bound inside the
 * locked cleanup proof, and any other barrier is left alone.
 */
export async function removeStaleBarrierOf(root: string, plan: string): Promise<void> {
  if ((await retireFenceState(root)).kind !== "stale") return;
  await clearStaleRetireBarrier(root, plan);
}
