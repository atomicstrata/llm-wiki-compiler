/**
 * @file src/preparations/settlement-pending.ts
 * @description The READ-ONLY selector of the gate's preparation-settlement
 * leg: which run, if any, the settlement pass
 * ({@link settlePreparationHandoffsWith}) would act on now, WITHOUT acting.
 *
 * A maintenance collector (indexed GC apply, indexed restore) takes the raw
 * project lock and must not settle anything as a side effect, yet must not run
 * while a settlement is owed. It refuses on what this selector names.
 *
 * SHARED DECISIONS. The pass's own skips (an inventory with problems or no
 * manifests, an unreadable key) and its run enumeration (`readableRuns`) are
 * the incumbent's; each per-run guard below is the guard that leg of
 * {@link settleRunRecoveryWith} applies before it writes, over the same
 * exported state sets and predicates:
 * - `handoff-started`: the handoff recovery leg (it may settle or park);
 * - a cancel-settleable state whose cancel is observed: the cancellation leg;
 * - an advisory-unconsumed state, not handoff-owned, with a requested cancel:
 *   the custody carry into `cancelling`;
 * - a terminal state with a requested cancel: the residue collection.
 * Nothing here writes.
 */

import { ADVISORY_UNCONSUMED_RUN_STATES, CANCEL_SETTLEABLE_RUN_STATES, handoffOwnsRunSettlement } from "./attempts/cancel-settlement.js";
import { preparationCancellationRequested } from "./cancellation.js";
import { cancellationObservedForRecovery, localHandoffSettlementSteps, readableRuns } from "./recovery.js";
import type { PreparationRunV1 } from "./run-types.js";
import { LEGAL_EDGES } from "./run-validation.js";

/** Whether the settlement pass would act on `run` in the project at `root`. */
async function settlementOwed(root: string, run: PreparationRunV1): Promise<boolean> {
  if (run.state === "handoff-started") return true;
  if (CANCEL_SETTLEABLE_RUN_STATES.has(run.state)) return cancellationObservedForRecovery(root, run);
  const requested = () => preparationCancellationRequested(root, run.workspaceId, run.runId);
  if (ADVISORY_UNCONSUMED_RUN_STATES.has(run.state)) return !handoffOwnsRunSettlement(run) && requested();
  return LEGAL_EDGES[run.state].size === 0 && requested();
}

/**
 * The first run (in inventory order) whose settlement the gate's pass would
 * perform now, as `<workspace>/<run>`, or null when it would perform none.
 */
export async function pendingPreparationSettlement(root: string): Promise<string | null> {
  const reads = localHandoffSettlementSteps(root);
  const inventory = await reads.scanInventory();
  if (inventory.problems.length > 0 || inventory.manifests.length === 0) return null;
  const key = await reads.readKeyEpoch();
  if (key.status !== "ok") return null;
  for (const { run } of await readableRuns(reads, inventory.manifests, key.keyEpochId)) {
    if (await settlementOwed(root, run)) return `${run.workspaceId}/${run.runId}`;
  }
  return null;
}
