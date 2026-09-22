/**
 * @file src/preparations/service-reset.ts
 * @description The `reset` operation — the operator's repair verb for a project
 * whose preparation key is missing or unreadable (design v10 §5 row 13,
 * D-10-12/D-10-14).
 *
 * IT IS THE ONLY OPERATION THAT IS NOT ON EVERY EXECUTION SURFACE, and the
 * restriction is enforced HERE rather than by leaving a method off a facade.
 * `createPreparationService` is a public export and reset costs
 * `preparation.quarantine` — the SAME token an SDK or MCP host legitimately
 * holds for `prune` and `sweep` — so a facade allowlist controls the MENU while
 * the door stands open: any embedder could construct the service and call reset
 * directly. The check and the executor therefore share one point, which is this
 * function. The facade's silence stays as a secondary control, catching an
 * accidental export; it is not the boundary.
 *
 * THE SURFACE IS NOT IN THE REQUEST, so a forged `surface: "cli"` is
 * unrepresentable rather than validated. It arrives from the service's own
 * construction, copied by value, exactly as `preview` receives it.
 *
 * THE CAPTURE PRECEDES THE SURFACE REFUSAL, and the order is deliberate rather
 * than incidental. Capturing reads data and does nothing else — it grants
 * nothing, acquires nothing and touches no byte — so refusing after it costs
 * nothing. Refusing BEFORE it would make this the one operation whose request is
 * never read by descriptor, and the totality control that pins that invariant
 * builds its service on the `sdk` surface. The consequence, stated so nobody
 * reads it as a gap: an SDK caller whose request is malformed learns that first
 * and the surface second. Every WELL-FORMED request meets the surface refusal.
 *
 * WHY IT SHIPS WITH ITS SUPERSEDE (§4 C3, and the pause slice's lesson applied
 * one surface over). Pass one records an intent marker and returns a one-time
 * secret; an operator who loses that secret cannot complete the reset, and until
 * the marker is gone NOTHING can acquire the project mutation lock — the gate
 * refuses non-destructive intents because a unit is pending and other
 * destructive intents because that unit is a reset holding custody. Supersede is
 * the only exit from that state, so shipping the verb without it would strand
 * exactly the operator this verb exists for. `pause` shipped once without its
 * `resume` on the same shape of argument and it did not survive review.
 *
 * TWO THINGS THIS OPERATION DOES NOT DO, both stated because their absence is
 * otherwise indistinguishable from an oversight:
 *
 *  - It supplies NO `targetUnitId` to the gate. Reset's §4 C3 row derives its
 *    target under the lock: pass one has no unit yet, and supersede clears a SET
 *    the operator cannot name. The continuation arm supplies its unit to the
 *    SUBSTRATE, which additionally authenticates it against the operator's
 *    secret — a stronger binding than a gate ticket, and the reason the gate's
 *    derived answer is a superset the executor narrows within.
 *  - It classifies no {@link LifecycleAuthorizationDivergedError}. Reset is one
 *    of the substrate's three deliberately UNGATED custody callers
 *    (`lifecycle-driver.ts`), so the driver never re-runs the gate predicate and
 *    that class cannot arrive from here. An arm for it would be unreachable code
 *    asserting a re-check that does not happen.
 *
 * THE RESULT CARRIES THE CONTINUATION SECRET, and that is the protocol rather
 * than a leak. §5's F5 classification bans key material from result DTOs; this
 * is not the preparation key and never becomes one. It is a one-time
 * authorization secret that is useless on its own — pass two additionally
 * requires the durable intent marker whose digest it must match, and that marker
 * self-binds to its own unit — and the two-pass reset cannot complete without
 * returning it to the operator who must present it. What is NOT carried is the
 * completed receipt: it enumerates object paths, so this projects the unit and
 * the epoch id and leaves the durable record as the authority.
 *
 * AND NOTHING CHECKED THIS EITHER WAY, which is the half worth writing down.
 * F5 specifies a serialization control walking every result DTO for banned
 * classes; **no such control ships** — searched, not assumed. So this paragraph
 * is a JUDGEMENT ON RECORD rather than a rule some test enforced: carrying the
 * secret went green because nothing was watching, and the reasoning above is
 * what a reviewer gets instead of a red. The day that control is built, this is
 * the entry it has to agree with or overrule.
 *
 * THE EXPOSURE IS BORNE BY THE OPERATOR, so the limit is stated where they can
 * see it as well as here: the secret reaches stdout, any `--json` capture, and —
 * unless it comes from `LLMWIKI_PREP_RESET_TOKEN` — a `ps`-visible argument on
 * pass two. A limit recorded only in source is a limit the person exposed to it
 * never reads.
 */

import { acquireMutationLock, RecoveryGateError } from "../operation-bundles/lock-gate.js";
// The same pairing the gate documents: the gate acquires, utils releases.
import { releaseLock } from "../utils/lock.js";
import { captureExactRecord, capturedOr } from "../utils/runtime-capture.js";
import { preparationRunActor } from "./principals.js";
import type { PreparationPrincipal, PreparationSurface } from "./principals.js";
import { PreparationResetError, resetPreparationKeyEpochLocked } from "./reset.js";
import type { ResetKeyEpochResult } from "./reset.js";
// RE-EXPORTED THROUGH THE SERVICE, not read from the substrate by the surface.
// The operator has to TYPE one of these, so the surface must be able to name
// them — and D-10-1 lets an adapter import the service and nothing else, which
// would otherwise leave the CLI with a hardcoded copy of a destructive
// confirmation phrase. A copy is how the tool comes to advertise a phrase the
// substrate no longer accepts.
export { FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION } from "./reset.js";
import { preparationResetPreflightRefusal } from "./service-readiness.js";
import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";

/** The one transport surface `reset` is exposed on (D-10-14). */
const RESET_SURFACE: PreparationSurface = "cli";

/**
 * Raised when an operation is invoked on a surface it is not exposed on.
 *
 * A CLASS OF ITS OWN, and reusing `PrincipalAuthorityError("invalid-principal")`
 * was rejected on the ground this program keeps paying for: the principal IS
 * valid and IS granted, and reporting "this operation is not available here" as
 * "your principal is invalid" collapses two different facts into one code a
 * consumer switches on. The host that hits this has a correct principal and the
 * right grant; what it does not have is the surface.
 *
 * A THROW rather than a `refused` result, for the same reason the service's own
 * forged-surface door throws: this is a statement about the CALLER's authority,
 * not an answer about the project, and it must not be silently discardable by a
 * consumer that never inspects a status field. The CLI — the only shipped
 * surface that can reach reset — never raises it.
 *
 * THIS DOES NOT WEAKEN "A BOUNDARY DOCUMENTED TO RETURN REFUSALS MUST NOT
 * THROW", and the distinction is worth stating rather than leaving to be
 * rediscovered. That rule governs answers **about the request or about the
 * project** — an ineligible key, a wrong confirmation, a busy lock, a pending
 * unit — and for every one of those, reset's returned-refusal contract stays
 * TOTAL. "This operation is not exposed on your surface" is not an answer about
 * the request at all; it is that the request should never have reached here.
 *
 * A `refused` ARM WOULD ALSO BE A DEAD BRANCH. No shipped surface can produce
 * it: the CLI is the only caller and it is always `cli`, so the honest answer to
 * "what exercises this arm?" would be "only a directly-constructed sdk service".
 * A member of a public union that nothing can return is exactly the shape this
 * program has already spent a round deleting.
 */
export class PreparationSurfaceError extends Error {
  constructor(
    readonly operation: string,
    readonly surface: PreparationSurface,
    readonly requiredSurface: PreparationSurface,
  ) {
    super(`the ${operation} operation is available only on the ${requiredSurface} surface; `
      + `this service is bound to ${surface}`);
    this.name = "PreparationSurfaceError";
  }
}

/** The continuation secret pass one returned, naming the unit it authorizes. */
export interface ResetContinuationV1 {
  /** The `rst-…` unit whose pending intent this continues. */
  readonly unitId: string;
  /** The one-time secret pass one minted, base64. */
  readonly token: string;
}

/**
 * Request for the `reset` operation. Carries no actor, surface or grant.
 *
 * The three arms are exclusive in intent and not in the type, because the
 * substrate is what decides between them: a request with no continuation and no
 * supersede is pass one, one with a continuation is pass two, and one with
 * `supersede` clears provably intent-only markers before pass one is attempted.
 */
export interface ResetRequestV1 {
  /**
   * The reason-specific destructive confirmation, passed through unchanged.
   *
   * NOT INFERRED HERE. Which phrase is required depends on whether the key is
   * absent or merely unreadable, and only the substrate learns that — under the
   * lock, from the real key state. A surface that guessed would be a second
   * authority for the operator's explicit acknowledgement.
   */
  readonly confirmation: string;
  /** Present on pass two: the unit and the secret pass one returned. */
  readonly continuation?: ResetContinuationV1;
  /** Clear provably intent-only reset markers whose secret is lost. */
  readonly supersede?: boolean;
}

/** Why a reset was eligible, derived from the substrate rather than restated. */
type ResetReasonV1 = Extract<ResetKeyEpochResult, { status: "intent-recorded" }>["reason"];

/** The closed outcome of one reset attempt. */
export type ResetResultV1 =
  | {
    readonly status: "intent-recorded";
    readonly unitId: string;
    readonly reason: ResetReasonV1;
    /** Present this, with the unit, to complete the reset. See the file docblock. */
    readonly continuationToken: string;
  }
  | { readonly status: "completed"; readonly unitId: string; readonly keyEpochId: string }
  | { readonly status: "superseded"; readonly unitIds: readonly string[] }
  | { readonly status: "refused"; readonly reason: string };

/** Project the substrate's outcome into the operation's own answer. */
function resetResult(outcome: ResetKeyEpochResult): ResetResultV1 {
  if (outcome.status === "intent-recorded") {
    return {
      status: "intent-recorded", unitId: outcome.unitId, reason: outcome.reason,
      continuationToken: outcome.continuationToken,
    };
  }
  if (outcome.status === "completed") {
    return { status: "completed", unitId: outcome.unitId, keyEpochId: outcome.keyEpochId };
  }
  return { status: "superseded", unitIds: outcome.unitIds };
}

/**
 * Re-capture the NESTED continuation by own data descriptors, or refuse.
 *
 * The outer capture is SHALLOW — `captureOwnDataRecord` copies own data values
 * and does not descend — so `continuation` arrives as the caller's own object
 * and reading `.unitId` off it would be the plain `[[Get]]` the outer capture
 * exists to prevent, one level in. This is the same inner-capture obligation
 * `handoff` carries for its nested obligations.
 *
 * EXACT KEYS, not a denylist: `captureExactRecord` refuses any record carrying a
 * key beyond the two, so an unexpected field cannot ride along unnoticed.
 */
function resolvedContinuation(
  supplied: unknown,
): { readonly ok: true; readonly continuation: ResetContinuationV1 } | { readonly ok: false } {
  const record = capturedOr(() => captureExactRecord(supplied, ["unitId", "token"]), () => null);
  if (record === null) return { ok: false };
  const { unitId, token } = record;
  if (typeof unitId !== "string" || typeof token !== "string") return { ok: false };
  return { ok: true, continuation: { unitId, token } };
}

/** Drive the substrate under the held lock and return its typed refusals. */
async function resetLocked(
  root: string, principal: PreparationPrincipal, request: ResetRequestV1,
  continuation: ResetContinuationV1 | undefined,
): Promise<ResetResultV1> {
  try {
    return resetResult(await resetPreparationKeyEpochLocked(root, {
      actor: preparationRunActor(principal),
      at: new Date().toISOString(),
      confirmation: request.confirmation,
      ...(continuation === undefined ? {} : { continuation }),
      ...(request.supersede === undefined ? {} : { supersedePendingReset: request.supersede }),
    }));
  } catch (error) {
    // A TYPED REFUSAL IS AN ANSWER. `key-healthy` is the ordinary case for an
    // operator who ran this on a project that turned out to be fine, and
    // `continuation-mismatch` is what a wrong token earns; letting either escape
    // as a throw would give `--json` an empty envelope.
    if (error instanceof PreparationResetError) {
      return { status: "refused", reason: `${error.code}: ${error.message}` };
    }
    // The gate's own class, arriving from under the lock rather than at
    // acquisition. `RecoveryGateError` is the base, so this covers every arm the
    // gate has and any it grows.
    if (error instanceof RecoveryGateError) return { status: "refused", reason: error.message };
    throw error;
  }
}

/**
 * Repair a project whose preparation key is missing or unreadable, or say why
 * not.
 *
 * `principal` is already captured and already charged its
 * `preparation.quarantine` grant by the service composition.
 *
 * @param root - The project root this invocation acts within.
 * @param surface - The service's OWN fixed surface, never a request field.
 * @param principal - The captured host principal the signed receipt attests.
 * @param request - The confirmation, and the continuation or supersede arm.
 * @returns The recorded intent, the completed reset, what was superseded, or the
 *   honest reason nothing happened.
 * @throws PreparationSurfaceError - When the host is not the CLI (D-10-14).
 */
export async function resetPreparationOperation(
  root: string, surface: PreparationSurface, principal: PreparationPrincipal,
  request: ResetRequestV1,
): Promise<ResetResultV1> {
  // CAPTURED IN THE SYNCHRONOUS PROLOGUE (D-10-9) and by DESCRIPTOR, ahead of
  // the first await — which is the preflight below.
  const captured = capturedRequest<ResetRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  // THE DOOR (D-10-14). One comparison, at the one place execution happens.
  if (surface !== RESET_SURFACE) throw new PreparationSurfaceError("reset", surface, RESET_SURFACE);
  const opened = captured.continuation === undefined
    ? { ok: true, continuation: undefined } as const
    : resolvedContinuation(captured.continuation);
  if (!opened.ok) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  // THE PREFLIGHT, AND IT IS NEITHER SIBLING'S. It carries a clause `prune` and
  // `sweep` do not — THE STORE MUST BE HERE — and drops one they do, the
  // unreadable-key refusal. Both differences were measured rather than reasoned:
  //
  //  - taking `resolveHostReadiness` made reset refuse an UNREADABLE key, which
  //    is one of exactly two states this verb exists to repair, telling the
  //    operator "preparation commands cannot proceed" while they held the one
  //    command that can. The key is classified under the lock instead, by the
  //    substrate, which tells healthy from absent from unreadable.
  //  - and WITHOUT the store clause, a reset run one directory below the project
  //    root created a fresh `.llmwiki`, recorded a pending unit in it and handed
  //    back a continuation token — exit 0, a plausible repair, and the operator's
  //    real project still broken. This verb needs that clause more than any
  //    other, because a bare directory and a project whose key was deleted give
  //    the substrate the identical answer.
  const blocked = await preparationResetPreflightRefusal(root);
  if (blocked !== null) return { status: "refused", reason: blocked };
  let acquired: boolean;
  try {
    // NO TICKET, AND THAT IS THE AUTHORIZATION MODEL RATHER THAN A GAP. Reset is
    // PROJECT-scoped (design v10 §4): its receipt enumerates project scope and
    // its supersession clears a SET, so no single unit id can describe what it
    // may touch. It briefly acquired through the per-unit ticket form, and that
    // produced two defects at once — a pending prune refused the repair
    // entirely, and the ticket it did receive named one unit while the executor
    // completed another, because nothing consumed it.
    //
    // WHAT AUTHORIZES EACH ARM INSTEAD, and each is stronger than a ticket:
    //  - the PROJECT LOCK, held across the whole call, serializes it against
    //    every other mutation;
    //  - CONTINUING is authenticated by the operator's secret against the
    //    durable intent marker, in `openContinuation`, which addresses the named
    //    unit directly and refuses a marker bound to any other;
    //  - SUPERSEDING is classified per unit under the lock by
    //    `supersedeIntentOnlyUnitsLocked`, which refuses any unit whose intent
    //    has materialized — a set-wide decision a one-unit ticket could not have
    //    expressed even if it had been consumed.
    acquired = await acquireMutationLock(root, "reset");
  } catch (error) {
    if (error instanceof RecoveryGateError) return { status: "refused", reason: error.message };
    throw error;
  }
  if (!acquired) return { status: "refused", reason: "project lock is busy" };
  try {
    return await resetLocked(root, principal, captured, opened.continuation);
  } finally {
    await releaseLock(root);
  }
}
