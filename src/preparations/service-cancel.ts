/**
 * @file src/preparations/service-cancel.ts
 * @description The `cancel` operation — publish one operator cancellation
 * request for a preparation run (design v10 §5 row 8).
 *
 * IT TAKES NO LOCK, AND THAT IS THE DESIGN RATHER THAN AN OMISSION. Every other
 * mutating operation here acquires the project lock through the recovery gate.
 * Cancel must not: the operator reaches for it exactly when a run is WEDGED, and
 * a wedged project is the one whose lock is held by a dead executor, whose
 * lifecycle maintenance is half-finished, or whose gate refuses everything. An
 * earlier revision of the operation table had cancel acquiring at `ordinary`
 * intent, which would have made it refuse precisely when it is needed. The
 * substrate primitive is named `writePreparationCancelLockFree` for the same
 * reason.
 *
 * IT ALSO TAKES NO READINESS PRECHECK, for the same reason and with the same
 * care. `resolveHostReadiness` fails on a present-but-broken profile and on an
 * unreadable preparation key. The advisory record needs NEITHER: its path is
 * derived from the workspace id the manifest carries, its bytes are canonical
 * and self-contained, and nothing in it is key-bound. Requiring the key here
 * would strand the wedged case this operation exists for — a refusal that leaves
 * a legitimate state unrecoverable is a defect, not a safety property.
 *
 * IT AUTHORIZES NOTHING AND SETTLES NOTHING. The advisory is intent: a
 * lock-holding orchestrator validates current state, appends the durable
 * transition, and removes the file. That settlement ALREADY EXISTS
 * (`attempts/cancel-settlement.ts`, re-driven by the §24.2 coordinator), so this
 * operation deliberately duplicates none of it.
 *
 * WHAT THE REQUEST DOES NOT CARRY: the requester. That label is actor identity,
 * and request DTOs carry no actor identity (D-10-9 / I2) — a caller-presented
 * one would be a self-asserted name on a durable-ish record. It is taken from
 * the host-assigned principal instead, so it says who the host authenticated.
 */

import { randomBytes } from "node:crypto";
import {
  isAdmissibleCancelRequester, readPreparationCancel, writePreparationCancelLockFree,
} from "./cancellation.js";
import type { PreparationRunId } from "./ids.js";
import { preparationRelativeCancelPath } from "./paths.js";
import type { PreparationPrincipal } from "./principals.js";
import type { PreparationManifestV1 } from "./manifest-parse.js";
import type { PreparationRunV1 } from "./run-types.js";
import { LEGAL_EDGES } from "./run-validation.js";
import {
  CANCEL_HONORABLE_RUN_STATES, handoffOwnsRunSettlement,
} from "./attempts/cancel-settlement.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { locatePreparationManifest, readPreparationRunForManifest } from "./service-run-lookup.js";

/** Request for the `cancel` operation. Carries no actor, surface or grant. */
export interface CancelRequestV1 {
  /** The run whose cancellation is being requested. */
  readonly runId: string;
}

/** The closed outcome of one cancellation request. */
export type CancelResultV1 =
  | {
    readonly status: "requested";
    readonly runId: string;
    /** Whether this call published the request or found one already pending. */
    readonly request: "created" | "already-pending";
  }
  | { readonly status: "refused"; readonly reason: string };

/** Advisory nonce width, matching the record's 128-bit lowercase-hex grammar. */
const CANCEL_NONCE_BYTES = 16;

/**
 * Whether anything could ever honor a cancellation published over this run, and
 * why not.
 *
 * THE DECISION IS THE DERIVED HONORABILITY SET, not terminality. A previous
 * revision refused only where `LEGAL_EDGES` was EMPTY, which reads terminality as
 * the rule when it is only one of the ways a request goes unconsumed:
 * `handoff-started` has edges, none of them to `cancelling`, and no attempt can
 * start from it — so a request published there could only ever be collected as
 * residue while the handoff completed anyway. Asking the set that every consumer
 * is derived from answers the actual question.
 *
 * TERMINALITY IS STILL READ, but only to choose the MESSAGE: "already finished"
 * and "past the point of no return" are different things to be told, and the
 * second one carries what to do next. Neither branch decides anything.
 *
 * This is a does-not-qualify refusal, distinct from the could-not-read leg below.
 */
function unhonorableRefusal(run: PreparationRunV1): string | null {
  // TERMINAL FIRST, and the order is load-bearing rather than stylistic. A
  // HANDED-OFF run satisfies the handoff-ownership test below — its start binding
  // is in the transitions forever — and telling an operator to "complete the
  // handoff first" over a run that already completed it would be false. A
  // terminal run has nothing to cancel whatever else is true of it, and its
  // advisory is the residue collector's.
  if (LEGAL_EDGES[run.state].size === 0) {
    return `this run is already terminal (${run.state}); there is nothing to cancel`;
  }
  // THE HANDOFF OWNS THE RUN, and it is a fact about the RECORD rather than about
  // the state. A run parked back from `handoff-started` sits at
  // `recovery-required` — a perfectly honorable state — while still carrying the
  // reserved identities that make every cancellation move unprovable, so a
  // state-only test admitted exactly the case no consumer can act on.
  if (handoffOwnsRunSettlement(run)) return committedHandoffRefusal(run);
  return CANCEL_HONORABLE_RUN_STATES.has(run.state) ? null : committedHandoffRefusal(run);
}

/** The one wording for "a handoff owns this run", so both legs say the same thing. */
function committedHandoffRefusal(run: PreparationRunV1): string {
  return `this run's handoff has already committed to its reserved bundle identities (${run.state}); `
    + "complete or park the handoff first — cancellation is admissible again from the state it settles to";
}

/**
 * The state refusal for a run whose durable record could be read, if any.
 *
 * AN UNREADABLE RUN PROCEEDS, and the asymmetry is deliberate. Refusing here
 * would tie cancellation to exactly the durable state whose unreadability is the
 * wedge — an integrity-invalid leaf, a rotated key epoch, a truncated write —
 * and would hand the operator nothing at the moment they need the request to
 * land. Proceeding is the FAIL-SAFE direction rather than a relaxation of
 * safety: the advisory authorizes nothing, every consumer validates current
 * state under the lock, and an unhonored request at worst requests the ordinary
 * safe path. That is the same reading `preparationCancellationRequested` already
 * takes of a forged file.
 *
 * It reads the run through the manifest the caller ALREADY located, so this
 * operation observes the inventory exactly once.
 */
async function stateRefusal(root: string, manifest: PreparationManifestV1): Promise<string | null> {
  const resolved = await readPreparationRunForManifest(root, manifest);
  return resolved.ok ? unhonorableRefusal(resolved.run) : null;
}

/**
 * Classify a create-only collision, rather than reporting it as idempotence.
 *
 * `writeAdvisoryCreateOnly` reports `exists` for ANY object already at the path
 * — a valid pending request, but equally a planted directory, a symlink or a
 * forged file. Mapping all of those to "already pending" would tell the operator
 * their cancellation is in flight when nothing consumable is there at all. So
 * the collision is READ BACK, and ALL THREE of the read's answers are kept
 * apart, because they call for three different moves:
 *
 *  - `present` — a valid pending request. Honest idempotence.
 *  - `absent` — the request was CONSUMED between the failed create and this
 *    read: a lock holder settled the run and dropped the advisory in that
 *    window. Could-not-see is not does-not-qualify (D-10-4), and collapsing this
 *    into the leg below told an operator to remove an "unreadable object" that
 *    is not there and that they cannot act on. Retryable, and it says so.
 *  - `unavailable` — something IS there and it is not a request.
 */
async function classifyCollision(
  root: string, workspaceId: string, runId: PreparationRunId,
): Promise<CancelResultV1> {
  const read = await readPreparationCancel(root, workspaceId, runId);
  if (read.status === "present") return { status: "requested", runId, request: "already-pending" };
  if (read.status === "absent") {
    return {
      status: "refused",
      reason: "a cancellation request for this run was settled while this one was being published; "
        + "re-run to see the run's current state",
    };
  }
  // NOT A DEAD END, and it must not read as one: the leaf is named
  // workspace-relative so an operator can clear it and retry. Removing it here
  // is not this operation's to do — removal is a lock-holder's move, and cancel
  // holds no lock by design.
  return {
    status: "refused",
    reason: "an unreadable object already occupies this run's cancel request path "
      + `(${preparationRelativeCancelPath(workspaceId, runId)}); remove it and request the cancellation again`,
  };
}

/**
 * Publish one cancellation request, or say why it could not be published.
 *
 * `principal` is already captured and already charged its `preparation.cancel`
 * grant by the service composition.
 *
 * @param root - The project root this invocation acts within.
 * @param principal - The captured host principal this request is credited to.
 * @param request - The run the caller named.
 * @returns Whether the request was published, already pending, or refused.
 */
export async function cancelPreparationOperation(
  root: string, principal: PreparationPrincipal, request: CancelRequestV1,
): Promise<CancelResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9), read once and threaded. A
  // field re-read after an await retargets the request at a run the caller never
  // named — the defect `stage` and `fail` both carry the fix for.
  //
  // BY DESCRIPTOR, because the prologue read was still a plain `[[Get]]`: an own
  // accessor executed and this operation went on to WRITE a durable cancellation
  // record for the run it returned.
  const captured = capturedRequest<CancelRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const runId = captured.runId;
  const requester = principal.id;
  // Checked through the SAME predicate the writer enforces, so this refuses
  // rather than letting the writer throw an untyped error out of the service.
  if (!isAdmissibleCancelRequester(requester)) {
    return { status: "refused", reason: "the host principal's identity is not an admissible requester label" };
  }
  const located = await locatePreparationManifest(root, runId);
  if (!located.ok) return { status: "refused", reason: located.reason };
  const refused = await stateRefusal(root, located.manifest);
  if (refused !== null) return { status: "refused", reason: refused };
  const { workspaceId, runId: manifestRunId } = located.manifest;
  // The MANIFEST's run id, not the caller's string: the id written into the
  // record is the one the located manifest carries, so the path and the record
  // are bound to the same authority the lookup resolved.
  const outcome = await writePreparationCancelLockFree(root, {
    workspaceId, runId: manifestRunId, requester,
    at: new Date().toISOString(), nonce: randomBytes(CANCEL_NONCE_BYTES).toString("hex"),
  });
  return outcome === "created"
    ? { status: "requested", runId, request: "created" }
    : classifyCollision(root, workspaceId, manifestRunId);
}
