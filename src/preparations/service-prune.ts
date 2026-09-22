/**
 * @file src/preparations/service-prune.ts
 * @description The `prune` operation — reclaim one retention-eligible terminal
 * run's exact bytes (design v10 §5 row 11).
 *
 * WHY THIS OPERATION EXISTS AT ALL, stated because "a delete verb" is not a
 * reason. Prune and sweep have existed inside `src/preparations` since Task 9E
 * and had no caller anywhere in `src/`, so no operator could reclaim anything;
 * `fail` drives a run terminal and reclaims nothing. This is the surface that
 * makes reclamation reachable.
 *
 * EXACTLY WHAT IT GIVES BACK, measured rather than claimed. It reclaims every
 * BYTE the run owned — after it runs, the destructive scan enumerates zero
 * leaves for that preparation — and it clears the run from the inventory. It
 * does NOT free a workspace preparation SLOT: the two-phase delete stages and
 * unlinks the exact enumerated leaves its signed plan attests, a directory has
 * no bytes to attest, and the workspace cap counts preparation DIRECTORIES. So
 * an emptied directory still counts, and a workspace at its ten-preparation cap
 * stays there. Freeing the slot needs an empty-directory reclamation inside the
 * delete protocol — permit-gated and fail-closed on a non-empty directory —
 * which is that protocol's own change to make. The limit is pinned by a test so
 * the day it is fixed, the expectation changes on purpose.
 *
 * IT IS THE FIRST GATED DESTRUCTIVE ACQUISITION IN THE TREE. Everything else
 * takes the mutation lock at `ordinary`, `review`, `handoff` or `recovery`, all
 * of which refuse while any lifecycle unit is pending. `prune` OWNS a unit, so
 * it acquires through the ticket-returning form and receives the exact unit the
 * gate authorized it to resume. The alternative — acquiring and then acting on
 * whatever this process's own capture happened to find — is the unbound-ticket
 * shape design v10 §4 C3 exists to remove.
 *
 * THE TARGET IS DERIVED, NEVER ACCEPTED. `pruneUnitIdFor` is a pure function of
 * the run id, and it is the SAME function the executor derives its unit from, so
 * the gate cannot authorize unit A while the substrate deletes unit B's bytes. A
 * request carries a run id and nothing else; there is no field through which a
 * unit id, an actor or a clock could be presented.
 *
 * TWO PATHS, AND THE SECOND ONE IS NOT AN OPTIMIZATION. An ordinary prune
 * resolves the run, checks eligibility and deletes. A prune that CRASHED has
 * already deleted the run leaf, so the run reads `absent` and no binding can be
 * resolved for it — measured, not assumed — while its unit stays pending and the
 * gate refuses every other mutation in the project until it is finished. If the
 * resume required a resolvable run, that project would be wedged forever by the
 * operation that is supposed to unwedge it. So a ticket for this run's own unit
 * is what authorizes the resume, and the substrate then requires a signed plan
 * that verifies under the current key before it touches anything.
 *
 * THE CLOCK IS THE SERVICE'S, NOT THE HOST'S. `PreparationServiceDependenciesV1`
 * deliberately carries no clock: the retention floor is the safety property that
 * keeps a run's bytes for thirty days, and a host-supplied clock would let an
 * embedder set it aside by naming a later instant. Fixtures move the RUN's
 * recorded instant instead, which is the thing the floor is actually measured
 * against.
 */

import {
  acquirePreparationMutationLock, RecoveryGateError,
} from "../operation-bundles/lock-gate.js";
import type { LifecycleAuthorizationV1 } from "../operation-bundles/lock-gate.js";
// The same pairing the gate documents: the gate acquires, utils releases.
import { releaseLock } from "../utils/lock.js";
import { pruneUnitIdFor } from "./prune-delete.js";
import { LifecycleAuthorizationDivergedError } from "./lifecycle-driver.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal } from "./principals.js";
import {
  PreparationPruneError, prunePreparationRunLocked, type PruneTargetV1,
} from "./retention.js";
import type { PruneReceiptV1 } from "./receipts.js";
import { resolveHostReadiness } from "./service-readiness.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { resolvePreparationRun } from "./service-run-lookup.js";

/** Request for the `prune` operation. Carries no actor, surface or grant. */
export interface PruneRequestV1 {
  /** The terminal run whose bytes are to be reclaimed. */
  readonly runId: string;
}

/** The closed outcome of one prune attempt. */
export type PruneResultV1 =
  | {
    readonly status: "pruned";
    readonly runId: string;
    /** The lifecycle unit whose signed receipt records exactly what was deleted. */
    readonly unitId: string;
    /**
     * Whether this call FINISHED work an earlier crashed call had planned,
     * rather than planning its own. An operator who did not ask for a resume
     * should be told they got one.
     */
    readonly resumed: boolean;
    readonly objectCount: number;
    readonly bytesReclaimed: number;
  }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Project the signed receipt into the result.
 *
 * COUNTS AND THE UNIT ID, never the object list. Every deleted object's logical
 * path is already recorded in the durable receipt, which is the authoritative
 * record; copying them into a response would put an unbounded, attacker-
 * influenceable list of paths on a surface whose size is otherwise bounded, for
 * no decision anyone makes from it.
 */
function pruned(runId: string, resumed: boolean, receipt: PruneReceiptV1): PruneResultV1 {
  return {
    status: "pruned", runId, unitId: receipt.unitId, resumed,
    objectCount: receipt.objects.length,
    bytesReclaimed: receipt.objects.reduce((total, object) => total + object.byteCount, 0),
  };
}

/**
 * Resolve what this call will act on, given the unit the gate authorized.
 *
 * A TICKET IS POSITIVE EVIDENCE OF UNFINISHED WORK — the gate matched a pending
 * unit against this run's own derived unit id — so it, and only it, authorizes
 * the path that does not need a resolvable run. Without one, the run must
 * resolve: an unreadable run with no pending unit is a run nothing has planned
 * to delete, and deleting on the strength of a failed read would be the
 * absence-of-evidence relaxation this program has already had to remove once.
 */
async function pruneTarget(
  root: string, runId: string, resuming: boolean,
): Promise<{ readonly ok: true; readonly target: PruneTargetV1 } | { readonly ok: false; readonly reason: string }> {
  if (resuming) return { ok: true, target: { kind: "unfinished", runId } };
  const resolved = await resolvePreparationRun(root, runId);
  return resolved.ok
    ? { ok: true, target: { kind: "run", binding: resolved.binding } }
    : { ok: false, reason: resolved.reason };
}

/** Drive the substrate and turn its typed refusals into returned values. */
async function pruneLocked(
  root: string, runId: string, authorization: LifecycleAuthorizationV1, principal: PreparationPrincipal,
): Promise<PruneResultV1> {
  // THE DECISION, NOT A BOOLEAN. `resumed: boolean` threw the gate's decision
  // away at this boundary and kept only the fact that one had been made — which
  // is why this path re-checked nothing at all. The whole authorization travels
  // so the driver can re-run the gate's predicate against its own capture.
  const resumed = authorization.ticket !== null;
  const target = await pruneTarget(root, runId, resumed);
  if (!target.ok) return { status: "refused", reason: target.reason };
  try {
    return pruned(runId, resumed, await prunePreparationRunLocked(root, {
      authorization,
      target: target.target,
      actor: preparationRunActor(principal),
      at: new Date().toISOString(),
      clock: { now: () => new Date() },
    }));
  } catch (error) {
    // A TYPED REFUSAL IS AN ANSWER, NOT A FAILURE. `not-eligible` is the ordinary
    // case — a run inside its retention floor, or one that is not terminal — and
    // letting it escape as a throw would give `--json` an empty envelope.
    if (error instanceof PreparationPruneError) {
      return { status: "refused", reason: `${error.code}: ${error.reason}` };
    }
    // THE SAME ANSWER AS THE GATE'S OWN REFUSAL, raised one step later. The
    // driver re-runs the gate's predicate over its own capture, so a prune
    // authorized against one lifecycle state and executing under another is
    // refused there rather than here. An unclassified class throws, and a
    // REACHABLE divergence throwing out of an operation documented to return a
    // refusal is exactly the contract falsity this change exists to remove.
    if (error instanceof LifecycleAuthorizationDivergedError) {
      return { status: "refused", reason: error.message };
    }
    // AND THE GATE'S OWN CLASS, which the driver can raise from the SAME
    // re-evaluation. `evaluateDestructiveAuthorization` refuses an unreadable
    // lifecycle, a visible reset custody, an unobservable registry, an
    // incomplete observation and an unowned unit by THROWING
    // PreparationLifecycleGateError -- only the ticket-divergence arm raises
    // the class below. Classifying one and not the other left the reproduced
    // race prevented but reported as a throw out of an operation documented to
    // return a refusal, which through the CLI or SDK is an empty envelope.
    //
    // RecoveryGateError is the base, so this covers every arm the gate has and
    // any it grows. The acquisition leg already classifies it; this is the same
    // answer arriving one step later, from the same predicate.
    if (error instanceof RecoveryGateError) {
      return { status: "refused", reason: error.message };
    }
    throw error;
  }
}

/**
 * Reclaim one eligible terminal run's bytes, or say why not.
 *
 * `principal` is already captured and already charged its `preparation.quarantine`
 * grant by the service composition.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal the signed receipt attests.
 * @param request - The run the caller named.
 * @returns What was reclaimed, or the honest reason nothing was.
 */
export async function prunePreparationOperation(
  root: string, principal: PreparationPrincipal, request: PruneRequestV1,
): Promise<PruneResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9), read once and threaded to the
  // gate ticket, the substrate call and the result. A field re-read after an
  // await is how a deletion came to be retargeted in this package once already.
  //
  // AND READ BY DESCRIPTOR, through the same primitive the other seven use.
  // Reading `request.runId` directly was a plain `[[Get]]`, so an own accessor
  // executed inside the prologue of the operation that DELETES BYTES. The
  // timing half was already right — one read, before the first await — which is
  // exactly why it survived: answering WHEN says nothing about HOW.
  const captured = capturedRequest<PruneRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const runId = captured.runId;
  // READINESS FIRST. This operation destroys durable key-bound bytes, so a
  // project whose own configuration cannot be read is not one to delete in.
  const ready = await resolveHostReadiness(root);
  if (!ready.ready) return { status: "refused", reason: ready.reason ?? "the project is not ready" };
  // THE TICKET IS REQUESTED WITH THIS RUN'S OWN DERIVED UNIT, before the lock is
  // held and from the request alone — no observation is involved, so there is
  // nothing here that a later capture could disagree with.
  const targetUnitId = pruneUnitIdFor(runId);
  let acquisition;
  try {
    acquisition = await acquirePreparationMutationLock(root, "prune", { targetUnitId });
  } catch (error) {
    // The gate's own refusal — unfinished work this prune does not own, an
    // unreadable registry, a key reset holding custody — is an answer about the
    // project, so it is returned rather than thrown.
    if (error instanceof RecoveryGateError) return { status: "refused", reason: error.message };
    throw error;
  }
  if (!acquisition.acquired) return { status: "refused", reason: "project lock is busy" };
  try {
    return await pruneLocked(root, runId, acquisition.authorization, principal);
  } finally {
    await releaseLock(root);
  }
}
