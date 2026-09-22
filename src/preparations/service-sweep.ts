/**
 * @file src/preparations/service-sweep.ts
 * @description The `sweep` operation — reclaim the leaves of every preparation
 * whose run is PROVABLY absent (design v10 §5 row 12).
 *
 * IT TAKES NO REQUEST, and that is a decision rather than an omission. Sweep
 * acts on whatever the project's own registry says is orphaned; there is no run
 * to name, no unit to name, and no option that would narrow it honestly. Giving
 * it a request object would create a surface for exactly the fields §4 C3 spent
 * a revision removing — a caller-supplied target — for no capability. It is the
 * only mutating operation with no input at all, so the whole class of
 * input-capture defects has nothing to attach to here.
 *
 * ITS TARGET IS THE ONE THAT MUST BE OBSERVED, and that is what makes this the
 * operation the ticket seam exists for. Prune derives its unit from the run id
 * the caller typed, so the gate and the executor agree by construction. Sweep's
 * unit id is a digest of the VISIBLE object paths, so it changes the moment the
 * first object is staged: a scan taken before the lock selects one unit, and the
 * executor's own capture under the lock selects another. The gate therefore
 * derives the target from ITS capture, hands back the unit it authorized, and
 * this operation carries that value into the substrate — which compares it
 * against its own capture and refuses divergence rather than deleting bytes
 * nothing approved.
 *
 * NOTHING-TO-SWEEP IS NOT A REFUSAL AND NOT AN ERROR. A healthy project has no
 * orphans, and running this verb on one is the expected case. It is also not the
 * same answer as an unreadable key: one says the project has nothing to reclaim,
 * the other says this call could not tell. Collapsing them would report a clean
 * project on the strength of a failed read.
 */

import {
  acquirePreparationMutationLock, RecoveryGateError,
} from "../operation-bundles/lock-gate.js";
import type { LifecycleAuthorizationV1 } from "../operation-bundles/lock-gate.js";
// The same pairing the gate documents: the gate acquires, utils releases.
import { releaseLock } from "../utils/lock.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import { LifecycleAuthorizationDivergedError } from "./lifecycle-driver.js";
import { PreparationQuarantineError } from "./quarantine.js";
import {
  sweepPreparationOrphansLocked, SweepUnobservableError,
} from "./retention.js";
import type { SweepOutcomeV1 } from "./retention.js";
import { resolveHostReadiness } from "./service-readiness.js";

/** The closed outcome of one sweep attempt. */
export type SweepResultV1 =
  | {
    readonly status: "swept";
    /** The lifecycle unit whose signed receipt records exactly what was deleted. */
    readonly unitId: string;
    /** Whether this call FINISHED a crashed sweep rather than planning its own. */
    readonly resumed: boolean;
    readonly objectCount: number;
    readonly bytesReclaimed: number;
  }
  | { readonly status: "nothing-to-sweep" }
  | { readonly status: "refused"; readonly reason: string };

/** Project the substrate's outcome into the operation's own answer. */
function sweepResult(outcome: SweepOutcomeV1, resumed: boolean): SweepResultV1 {
  if (outcome.status === "nothing-to-sweep") return { status: "nothing-to-sweep" };
  if (outcome.status === "key-unavailable") {
    return {
      status: "refused",
      reason: "the preparation key could not be read, so an orphan's owner cannot be classified",
    };
  }
  return {
    status: "swept", unitId: outcome.receipt.unitId, resumed,
    objectCount: outcome.receipt.objects.length,
    // Counts only, never the object list: every path is already in the durable
    // signed receipt, and copying an unbounded set of them into a response puts
    // attacker-influenceable strings on a surface with no decision to make from
    // them.
    bytesReclaimed: outcome.receipt.objects.reduce((total, object) => total + object.byteCount, 0),
  };
}

/** Drive the substrate under the held lock, carrying the authorized unit. */
async function sweepLocked(
  root: string, authorization: LifecycleAuthorizationV1, principal: PreparationPrincipal,
): Promise<SweepResultV1> {
  const expectedUnitId = authorization.ticket?.unitId ?? null;
  try {
    const outcome = await sweepPreparationOrphansLocked(root, {
      actor: preparationRunActor(principal),
      at: new Date().toISOString(),
      authorization,
    });
    return sweepResult(outcome, expectedUnitId !== null);
  } catch (error) {
    // EVERY ANSWER ABOUT THE PROJECT IS A RETURNED VALUE, and this arm used to
    // carry only the first of them. A refusal that escapes as a throw gives
    // `--json` an EMPTY envelope — measured through the binary: exit 1, stdout
    // "" — so a consumer that asked for a machine-readable answer got nothing
    // at all. Each class below is a fact about the project, not a defect:
    //
    //  - divergence: this capture resolved a different unit than the gate
    //    authorized. Nothing was deleted; the comparison precedes the key read
    //    and all planning.
    //  - unobservable: the prune registry could not be trusted, or it holds
    //    another operation's unfinished work.
    //  - incomplete inventory: the destructive scan refused to plan a scope
    //    from a partial view of the store.
    //
    // Anything else still throws, because a class nobody has classified is not
    // something to report as an orderly refusal.
    // THE DIVERGENCE CLASS MOVED UP A LAYER. The sweep-specific comparison it
    // named was a strict subset of the driver's re-evaluation and is gone; this
    // is the same answer raised by the gate's own predicate. Classifying it is
    // NOT optional bookkeeping -- the comment below says an unclassified class
    // still throws, and a reachable divergence throwing out of an operation
    // documented to return a refusal is the contract falsity this slice exists
    // to remove.
    if (error instanceof LifecycleAuthorizationDivergedError) return { status: "refused", reason: error.message };
    // AND THE GATE'S OWN CLASS, from the SAME re-evaluation. Only the
    // ticket-divergence arm raises the class above; the gate's other refusals --
    // unreadable lifecycle, visible reset custody, unobservable registry,
    // incomplete observation, unowned unit -- throw PreparationLifecycleGateError.
    // Classifying one and not the other left the reproduced race prevented but
    // reported as a THROW out of an operation documented to return a refusal,
    // which through the CLI or SDK is an empty envelope. RecoveryGateError is the
    // base, so this covers every arm the gate has and any it grows.
    if (error instanceof RecoveryGateError) return { status: "refused", reason: error.message };
    if (error instanceof SweepUnobservableError) return { status: "refused", reason: error.message };
    if (error instanceof PreparationQuarantineError) {
      return { status: "refused", reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
}

/**
 * Reclaim every provably-orphaned preparation's bytes, or say why not.
 *
 * `principal` is already captured and already charged its `preparation.quarantine`
 * grant by the service composition.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal the signed receipt attests.
 * @returns What was reclaimed, that there was nothing, or why nothing happened.
 */
export async function sweepPreparationOperation(
  root: string, principal: PreparationPrincipal,
): Promise<SweepResultV1> {
  // READINESS FIRST. This operation destroys durable key-bound bytes, so a
  // project whose own configuration cannot be read is not one to delete in.
  const ready = await resolveHostReadiness(root);
  if (!ready.ready) return { status: "refused", reason: ready.reason ?? "the project is not ready" };
  let acquisition;
  try {
    // NO `targetUnitId`. Supplying one is refused by the gate rather than
    // ignored, so this absence is enforced at the other end too.
    acquisition = await acquirePreparationMutationLock(root, "sweep");
  } catch (error) {
    if (error instanceof RecoveryGateError) return { status: "refused", reason: error.message };
    throw error;
  }
  if (!acquisition.acquired) return { status: "refused", reason: "project lock is busy" };
  try {
    return await sweepLocked(root, acquisition.authorization, principal);
  } finally {
    await releaseLock(root);
  }
}
