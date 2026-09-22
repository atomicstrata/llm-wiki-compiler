/**
 * @file src/preparations/attempts/cancel-settlement.ts
 * @description Cancellation settlement: driving a cancel-interrupted preparation
 * run from `cancelling` or the fail-closed `recovery-required` park to its HONEST
 * terminal (design section 23.2 — "a safe effect-free attempt may end
 * `cancelled`", "known applied effects produce `cancelled-with-effects`", "an
 * unknown effect produces `recovery-required`" — and the under-lock coordinator
 * move of section 24.2, "advance a cancellation whose effects are fully
 * observed").
 *
 * The classification reads DURABLE state only: the run's authenticated
 * effect/broker ledger and the digest-bound immutable plan. It never reads the
 * leg's in-memory belief, because a cancelled provider result does not surface
 * the receipts of the requests that were in flight when it was cancelled. The
 * durable ledger is strictly stronger — an effect cannot reach a broker without
 * `recordEffectStartLocked` first appending its `started` record under the lock.
 *
 * That applies to WHICH TERMINAL a run reaches. WHETHER a cancel was requested
 * at all is a separate question with two sources — the executor's own delivery
 * record and the advisory file — unioned in
 * {@link settleAttemptCancellationLocked}. Neither of those is provider prose:
 * one is what this host observed and acted on, the other is the operator's own
 * confined request. What the leg CLAIMS still decides nothing.
 *
 * It is deliberately ASYMMETRIC. `cancelled-with-effects` needs positive
 * authenticated evidence that an effect applied (a host-receipted `applied`
 * summary with its matching settled broker request). Cleanly-`cancelled` is the
 * RELAXING classification, so it needs positive STRUCTURAL proof that no effect
 * could have applied — the authenticated plan declares no mutating effect on any
 * phase. An empty ledger under an effect-CAPABLE plan is absence of evidence and
 * settles nothing: the run is left exactly where it is, recoverable, and is never
 * claimed cleanly cancelled.
 */

import { preparationCancellationRequested, removePreparationCancelLocked } from "../cancellation.js";
import { preparationManifestDigest } from "../manifest-parse.js";
import { readPreparationManifest } from "../manifest-store.js";
import { phaseDeclaresMutatingEffect } from "../plan-graph.js";
import { preparationRunPredecessor } from "../run-integrity.js";
import { appendPreparationTransitionLocked, handoffStartBinding, readPreparationRun } from "../run-store.js";
import {
  LEGAL_EDGES, OWNER_ACTIVE_STATES, runHasAppliedEffect, unresolvedLedgerReason,
} from "../run-validation.js";
import { ATTEMPT_STARTABLE_RUN_STATES } from "./types.js";
import type { NormalizedPreparationPlanV1 } from "../plan-types.js";
import type {
  AppendPreparationTransitionInput, PreparationPrincipalV1, PreparationRunBinding,
  PreparationRunState, PreparationRunTransitionV1, PreparationRunV1,
} from "../run-types.js";
import type { AttemptExecutionRequestV1, AttemptOutcomeV1 } from "./types.js";

/** The honest terminals a cancel-interrupted run may settle to. */
export type CancelTerminalState = "cancelled" | "cancelled-with-effects";

/** Why a cancel-interrupted run cannot yet settle to any honest terminal. */
export type CancelSettlementBlock =
  | "unresolved-effect"
  | "pending-broker-request"
  | "unauthenticated-applied-effect"
  | "effect-freeness-unproven"
  | "execution-owner-in-flight"
  | "park-not-a-cancellation"
  | "handoff-effects-outside-plan"
  | `run-not-cancellable-${PreparationRunState}`;

/** The pure classification of one cancel-interrupted run. */
type CancelSettlementV1 =
  | { readonly kind: "terminal"; readonly state: CancelTerminalState }
  | { readonly kind: "blocked"; readonly reason: CancelSettlementBlock };

/**
 * The durable states a cancellation settlement may advance FROM.
 *
 * EXPORTED so the under-lock recovery coordinator selects the runs it re-drives
 * from the SAME set this module enforces. A coordinator that re-stated the set
 * could drift from the executor it feeds — either skipping a settleable run
 * forever or calling settlement on a state it must refuse — so the guard and its
 * executor share one enumeration rather than two copies of it.
 */
export const CANCEL_SETTLEABLE_RUN_STATES: ReadonlySet<PreparationRunState> =
  new Set<PreparationRunState>(["cancelling", "recovery-required"]);

/** The terminals a settlement may observe as ALREADY reached (idempotent re-drive). */
const CANCEL_TERMINALS = new Set<PreparationRunState>(["cancelled", "cancelled-with-effects"]);

/**
 * The states from which a published advisory has NO consumer at all — derived
 * from every consumer's own enumeration, never listed.
 *
 * A cancellation advisory is consumed by exactly three things: the attempt
 * executor polls it while a run is startable, this module's settlement advances a
 * run already carrying the cancel, and the coordinator's terminal leg collects
 * the residue once the run can move no further. Subtract all three from the
 * states that can still ACCEPT the cancel — the ones whose edge set admits
 * `cancelling` — and what is left is the strand: an operator told their
 * cancellation was requested, over a run nothing will ever cancel.
 *
 * A state that can hold an EXECUTION OWNER is subtracted too, and that is the
 * safety half rather than a convenience. Carrying such a run to `cancelling`
 * would move a run whose attempt may still be in flight, and a sweep that runs
 * inside an unrelated mutation's lock acquisition has no way to tell a stranded
 * owner from a busy one. Those states keep the attempt path as their consumer;
 * the residual — a DEAD owner in one of them — is a pre-existing liveness
 * question this set deliberately does not answer.
 *
 * Today this derives to exactly `{handoff-ready}`. The value of deriving a
 * one-member set is that the four subtrahends are the reason it has one member:
 * a state that later loses its executor coverage, or an edge added to
 * `cancelling`, joins it without anyone remembering to.
 */
export const ADVISORY_UNCONSUMED_RUN_STATES: ReadonlySet<PreparationRunState> = new Set(
  (Object.keys(LEGAL_EDGES) as PreparationRunState[]).filter((state) =>
    LEGAL_EDGES[state].has("cancelling")
    && !ATTEMPT_STARTABLE_RUN_STATES.has(state)
    && !CANCEL_SETTLEABLE_RUN_STATES.has(state)
    && !OWNER_ACTIVE_STATES.has(state)),
);

/**
 * The states from which a published cancellation can still be HONORED by
 * something — DERIVED, and the answer to the only question the publishing
 * surface should be asking.
 *
 * A cancel is honored in exactly three ways: an attempt observes it while one can
 * still start, the run already carries it and the settlement advances it, or the
 * state's own edge set admits `cancelling` so the request can be carried there.
 * The union of those three is this set.
 *
 * IT REPLACES A TEST OF TERMINALITY, and the difference is a real state. The
 * publishing surface used to refuse only where `LEGAL_EDGES` was EMPTY, which
 * admitted `handoff-started` — a state with edges, none of them to `cancelling`,
 * and no attempt startable from it. A cancellation published there could only
 * ever be collected as residue, never acted on, so the operator was told their
 * request was in flight over a run that was going to hand off regardless. Every
 * terminal is still refused, because a terminal satisfies none of the three
 * disjuncts either — terminality was a sufficient reason, not the rule.
 */
export const CANCEL_HONORABLE_RUN_STATES: ReadonlySet<PreparationRunState> = new Set(
  (Object.keys(LEGAL_EDGES) as PreparationRunState[]).filter((state) =>
    ATTEMPT_STARTABLE_RUN_STATES.has(state)
    || CANCEL_SETTLEABLE_RUN_STATES.has(state)
    || LEGAL_EDGES[state].has("cancelling")),
);

/**
 * Positive structural proof that no mutating external effect can EVER have
 * applied under this plan: no phase can mutate at all, so there is no authorized
 * entry to the broker.
 *
 * It reads the SHARED phase predicate rather than testing `effectPlanDigest`
 * alone. A phase that budgets effects (`maximumEffectsPerAttempt > 0`) without
 * declaring a digest is loader-admissible, and a digest-only reading called such
 * a plan effect-free — while the executor, which keys its fail-closed cancel park
 * on that same budget, called it effect-capable. The two disagreeing is what let
 * a run the executor had just parked as unprovable be settled cleanly cancelled.
 *
 * Derived from the plan's own phase declarations rather than from the
 * `atomicityClass` LABEL, because that label is only re-enforced at runtime for
 * `durable-preparation` plans; the declarations are what the effect path actually
 * binds against.
 */
function planForbidsMutatingEffects(plan: NormalizedPreparationPlanV1): boolean {
  return !plan.phases.some(phaseDeclaresMutatingEffect);
}

/**
 * True when a HANDOFF owns this run's settlement.
 *
 * A run that reached `handoff-started` reserved durable Milestone A identities
 * and may have created a bundle that lives OUTSIDE this run's effect ledger. The
 * plan's phase declarations prove nothing about it, so every cancellation move
 * here would be reasoning from an authority that does not cover the durable state
 * in question. Only the handoff's own command can resolve it.
 *
 * ONE HOME, because three call sites need the same fact and two of them had their
 * own copy: the classifier blocks on it, the coordinator's settlement leg
 * early-returns on it, and the CARRY leg omitted it entirely — so an advisory
 * over a `handoff-ready` run that already carried a start binding was carried
 * into `cancelling`, where the only writer that could move it on is never
 * reached. The publishing surface reads it too, so an operator is told the
 * handoff owns the run instead of being handed a request nothing will act on.
 *
 * @param run - The authenticated run to classify.
 * @returns Whether a durable handoff has reserved identities for this run.
 */
export function handoffOwnsRunSettlement(run: PreparationRunV1): boolean {
  return handoffStartBinding(run) !== undefined;
}

/** The durable park code proving a `recovery-required` park WAS a cancellation. */
const CANCEL_PARK_CODE = "preparation-cancellation-effect-unproven";

/**
 * The transition that produced the run's CURRENT state.
 *
 * Derived from each record's own `stateBefore`/`stateAfter` rather than from a
 * restated list of annotation transition types: a transition that did not change
 * the state did not produce it, whatever its type. Post-terminal notices and
 * same-state progress records are skipped for free, and a new annotation type
 * cannot silently escape the scan.
 */
function stateProducingTransition(run: PreparationRunV1): PreparationRunTransitionV1 | undefined {
  for (let index = run.transitions.length - 1; index >= 0; index--) {
    const transition = run.transitions[index]!;
    if (transition.stateAfter !== transition.stateBefore) return transition;
  }
  return undefined;
}

/**
 * POSITIVE durable evidence that a `recovery-required` run was parked BY a
 * cancellation, read from the record that produced the park.
 *
 * `recovery-required` is the shared destination of every fail-closed park —
 * authority drift, a bounds violation, a failed publication, an unprovable
 * cancellation. An advisory `.cancel` file sitting beside such a run is NOT
 * evidence the park was about cancellation: anyone may write one at any time, so
 * treating its presence as proof let a cancel request carry an unrelated
 * integrity obligation to a terminal and erase it (design section 24.4). Only the
 * park's own recorded code says why the run is parked, so only that authorizes
 * advancing it.
 */
function parkedByCancellation(run: PreparationRunV1): boolean {
  const produced = stateProducingTransition(run);
  return produced?.payload.kind === "problem" && produced.payload.code === CANCEL_PARK_CODE;
}

/** Build one blocked classification. */
function blocked(reason: CancelSettlementBlock): CancelSettlementV1 {
  return { kind: "blocked", reason };
}

/**
 * Classify one cancel-interrupted run from durable evidence alone, fail-closed.
 *
 * A run still carrying an execution owner has an attempt in flight and is not
 * settleable at all. An unresolved ledger — a `planned`/`started`/
 * `outcome-unknown` effect, a pending broker request, or an `applied` claim
 * missing its receipt or settled request — blocks BOTH terminals, because an
 * unproven mutation can neither be denied nor honestly reported. Only then does
 * the two-way split apply: an authenticated applied effect is
 * `cancelled-with-effects`; otherwise cleanly-`cancelled` requires the plan's own
 * structural proof of effect-freeness, and absence of ledger entries never
 * substitutes for it.
 */
function classifyCancelSettlement(
  run: PreparationRunV1, plan: NormalizedPreparationPlanV1,
): CancelSettlementV1 {
  if (run.executionOwner !== undefined) return blocked("execution-owner-in-flight");
  // A run that reached `handoff-started` may have created a Milestone A bundle
  // that lives OUTSIDE this run's effect ledger, and the plan's phase
  // declarations prove nothing about it — a `local-bundle-only` plan has no
  // effect digest by construction, so the effect-freeness proof below would pass
  // over durable state another authority owns. Only the handoff's own command can
  // resolve that. Enforced HERE, in the primitive, so the exported settlement and
  // every caller inherit it rather than each remembering to guard.
  if (handoffOwnsRunSettlement(run)) return blocked("handoff-effects-outside-plan");
  const unresolved = unresolvedLedgerReason(run);
  if (unresolved !== null) return blocked(unresolved.kind);
  // AFTER the ledger, deliberately. Both refuse and neither writes, so the order
  // decides only which truth is reported — and an unresolved mutation is the more
  // actionable one. A run parked for an unknown effect outcome is also not a
  // cancellation park, and saying so would bury the effect obligation that
  // actually has to be resolved.
  if (run.state === "recovery-required" && !parkedByCancellation(run)) return blocked("park-not-a-cancellation");
  if (runHasAppliedEffect(run)) return { kind: "terminal", state: "cancelled-with-effects" };
  return planForbidsMutatingEffects(plan)
    ? { kind: "terminal", state: "cancelled" }
    : blocked("effect-freeness-unproven");
}

/** The result of one under-lock cancellation settlement attempt. */
export type CancelSettlementOutcomeV1 =
  | { readonly status: "settled"; readonly state: CancelTerminalState }
  | { readonly status: "blocked"; readonly reason: CancelSettlementBlock }
  | { readonly status: "unavailable"; readonly detail: string };

/** Inputs for one under-lock cancellation acknowledgement or settlement. */
export interface CancelSettlementInput {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  readonly principal: PreparationPrincipalV1;
  readonly at: string;
}

/**
 * Read the immutable plan the run is BOUND to. The manifest digest must equal the
 * binding's, so the effect-freeness proof is taken from the authenticated plan
 * this run was staged against and never from a manifest swapped underneath it.
 */
async function readBoundPlan(input: CancelSettlementInput): Promise<NormalizedPreparationPlanV1 | null> {
  const read = await readPreparationManifest(input.root, input.binding.workspaceId, input.binding.preparationId);
  if (read.status !== "ok" || preparationManifestDigest(read.manifest) !== input.binding.manifestDigest) return null;
  return read.manifest.plan;
}

/**
 * Append the terminal transition through the authenticated run-store writer. The
 * transition type IS the state: the loader's type-to-target table, legal-edge
 * table, and terminal effect rules all re-run over the signed record before it is
 * written, so the classifier's decision is re-proved by the enforcement it shares
 * rather than merely trusted. The actor is named field by field so no caller
 * input can be spread into the recorded principal.
 */
async function appendCancelTerminalLocked(
  input: CancelSettlementInput, run: PreparationRunV1, state: CancelTerminalState,
): Promise<void> {
  const transition: AppendPreparationTransitionInput = {
    type: state, stateAfter: state,
    actor: { id: input.principal.id, surface: input.principal.surface }, at: input.at,
    payload: { kind: "none" },
  };
  await appendPreparationTransitionLocked(input.root, input.binding, preparationRunPredecessor(run), transition);
}

/**
 * Append the durable run-level `cancelling` transition, capturing the operator's
 * cancel as SIGNED RUN STATE (design section 23.2: "no new ordinary phase
 * starts"). Once the run is `cancelling`, the attempt executor's startable-state
 * gate refuses every new or sibling phase attempt, so a cancelled phase can never
 * be silently restarted — the durable truth, not the consumable advisory, is what
 * makes cancellation sticky. A run no longer `running` (already settling or
 * terminal) is left untouched. The caller holds the project lock.
 *
 * RETURNS whether the record was actually appended. The caller drops the
 * consumed advisory only once the operator's intent is durably held somewhere,
 * and this append is one of the two places it can be held; reporting the append
 * is what lets the caller tell "captured as `cancelling`" from "read failed,
 * nothing written", which previously looked identical from outside.
 */
export async function recordDurableCancellingLocked(input: CancelSettlementInput): Promise<boolean> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok" || read.run.state !== "running") return false;
  await appendCancellingLocked(input, read.run);
  return true;
}

/** The one `cancelling` append, shared by both the states that can produce it. */
async function appendCancellingLocked(
  input: CancelSettlementInput, run: PreparationRunV1,
): Promise<void> {
  await appendPreparationTransitionLocked(input.root, input.binding, preparationRunPredecessor(run), {
    type: "cancelling", stateAfter: "cancelling",
    actor: { id: input.principal.id, surface: input.principal.surface }, at: input.at,
    payload: { kind: "none" },
  });
}

/**
 * TAKE CUSTODY of an advisory nothing else will ever consume.
 *
 * A cancellation published over a run in {@link ADVISORY_UNCONSUMED_RUN_STATES}
 * had no consumer at all: no attempt can start there, the settlement below does
 * not select the state, and the terminal residue collector skips it because the
 * run can still move. The operator was told their cancellation was requested and
 * nothing was ever going to act on it — and for `handoff-ready` the handoff
 * command then refused on that same advisory FOREVER, so the run had no exit
 * either. A refusal that leaves a legitimate state unrecoverable is a defect.
 *
 * Carrying the request into the durable `cancelling` record is the take-custody
 * answer rather than a retraction verb: it asserts no terminal, claims nothing
 * about effects, and hands the run to the settlement that already exists — which
 * either proves a terminal or parks it at `recovery-required`. Either way the
 * advisory has a consumer and the run has an exit.
 *
 * IT CANNOT MOVE A BUSY RUN, and that is structural rather than a check here:
 * every state that can record an execution owner is subtracted from the set, and
 * the run loader refuses an owner outside those states, so a run this selects has
 * no attempt in flight by construction.
 *
 * @param input - Root, the run's binding, the settling principal, and the instant.
 * @returns Whether the durable `cancelling` record was appended.
 */
export async function carryAdvisoryIntoCancellingLocked(
  input: CancelSettlementInput,
): Promise<boolean> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok" || !ADVISORY_UNCONSUMED_RUN_STATES.has(read.run.state)) return false;
  const run = read.run;
  // THE SIBLING GUARD. Both other cancellation legs apply it; this one omitted
  // it, and a `handoff-ready` run CAN already carry a start binding (it reached
  // `handoff-started` and was parked back). Carrying such a run to `cancelling`
  // lands it where the classifier blocks forever and no writer of
  // `cancelling -> recovery-required` is ever reached.
  if (handoffOwnsRunSettlement(run)) return false;
  if (!await preparationCancellationRequested(input.root, run.workspaceId, run.runId)) return false;
  await appendCancellingLocked(input, run);
  return true;
}

/**
 * Move a run that cannot settle OUT of `cancelling`, into the park designated for
 * the unprovable case.
 *
 * `cancelling` has no exits of its own. Its only legal successors are the two
 * cancel terminals and `recovery-required`; a blocked classification refuses both
 * terminals, no attempt can start (the executor refuses any run that is not
 * `planned` or `running`), the coordinator sweep re-blocks on every pass, and
 * abandonment requires `recovery-required` — so a run that honestly cancelled
 * under an effect-capable plan was stuck there permanently, with the operator's
 * advisory already consumed. A refusal that leaves a legitimate state
 * unrecoverable is a defect, not a safety property.
 *
 * Parking preserves every safety property the refusal was protecting: no terminal
 * is claimed, no effect is asserted either way, the run is still unstartable, and
 * the park carries the cancellation code so what put it there stays legible. What
 * it adds is the exit — `recovery-required` is the state design section 23.2
 * designates for exactly this case, and it is the one abandonment accepts.
 *
 * Once parked, the classification cannot improve: no attempt can run, so no new
 * evidence can reach the ledger. The park is where the run rests until an
 * operator abandons or supersedes it.
 */
async function escapeUnsettleableCancelling(
  input: CancelSettlementInput, run: PreparationRunV1, reason: CancelSettlementBlock,
): Promise<CancelSettlementOutcomeV1> {
  // A run whose attempt is still IN FLIGHT is not stranded — that attempt holds
  // the lease and will settle it. Parking here would clear nothing and strip the
  // fencing out from under live work, turning a transient block into damage.
  if (run.state !== "cancelling" || run.executionOwner !== undefined) return { status: "blocked", reason };
  await appendPreparationTransitionLocked(input.root, input.binding, preparationRunPredecessor(run), {
    type: "recovery-required", stateAfter: "recovery-required",
    actor: { id: input.principal.id, surface: input.principal.surface }, at: input.at,
    payload: { kind: "problem", code: CANCEL_PARK_CODE },
  });
  return { status: "blocked", reason };
}

/**
 * Advance one cancel-interrupted run to its honest terminal UNDER the project
 * lock, writing NOTHING when the terminal is not provable: an unsettleable run is
 * left in its current recoverable state rather than forced anywhere.
 *
 * IDEMPOTENT. A run already at a cancel terminal reports settled without writing,
 * so the two-append `running -> cancelling -> terminal` sequence can be re-driven
 * safely after a crash between its halves — re-driving from `cancelling`
 * completes it, and re-driving from the terminal is a no-op.
 *
 * BEING RE-DRIVABLE IS NOT BEING RE-DRIVEN. The attempt path cannot reach a
 * crashed `cancelling` run at all: the executor's own preconditions park any run
 * that is not `planned` or `running`, so nothing on this path revisits it. The
 * caller that actually re-drives it is the under-lock recovery coordinator
 * (`settlePreparationHandoffsLocked` in {@link file://../recovery.ts}), which
 * sweeps settleable runs on every gated mutation acquisition.
 */
export async function settleCancelledRunLocked(input: CancelSettlementInput): Promise<CancelSettlementOutcomeV1> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") return { status: "unavailable", detail: `run-${read.status}` };
  const state = read.run.state;
  if (CANCEL_TERMINALS.has(state)) return { status: "settled", state: state as CancelTerminalState };
  if (!CANCEL_SETTLEABLE_RUN_STATES.has(state)) return { status: "blocked", reason: `run-not-cancellable-${state}` };
  const plan = await readBoundPlan(input);
  if (plan === null) return { status: "unavailable", detail: "manifest-unavailable" };
  const classified = classifyCancelSettlement(read.run, plan);
  if (classified.kind === "blocked") return escapeUnsettleableCancelling(input, read.run, classified.reason);
  await appendCancelTerminalLocked(input, read.run, classified.state);
  return { status: "settled", state: classified.state };
}

// --- The attempt-executor entry point -----------------------------------

/** The under-lock settlement inputs for one attempt's run and operator actor. */
function attemptSettlementInput(request: AttemptExecutionRequestV1): CancelSettlementInput {
  return {
    root: request.root, binding: request.binding,
    principal: { id: request.principal.id, surface: request.principal.surface }, at: request.clock.now(),
  };
}

/**
 * Capture the operator's cancel as DURABLE run state and settle its honest
 * terminal, then drop the consumed advisory. A phase that honestly settled
 * `cancelled` first records the run-level `cancelling`, the signed truth that
 * keeps cancellation sticky once the advisory is gone; settlement then advances
 * `cancelling` — or the fail-closed `recovery-required` park a possibly-applied
 * mid-flight cancel leaves behind — to its honest terminal when durable evidence
 * proves which, and writes nothing when it does not.
 *
 * TWO SOURCES SAY A CANCEL WAS REQUESTED, AND THEY ARE UNIONED.
 *
 * `deliveredCancellation` is what the executor ITSELF observed and acted on
 * during the leg (see {@link file://./cancel-delivery.ts}). It is a fact about
 * the past that nothing can retract: the leg was stopped, and no later change to
 * a file un-does that. Re-deriving it from the advisory alone meant a request
 * retracted between delivery and commit erased an observation already acted on,
 * leaving the phase `cancelled` while the run stayed `running` — cancellation
 * that was not sticky.
 *
 * The advisory re-read stays, and only ADDS: a request that arrives after
 * delivery but before this commit was never observed by the leg, and is still an
 * operator cancel this attempt must honor. Neither source can veto the other.
 *
 * The advisory is removed ONLY once its intent is durably captured, as the sticky
 * `cancelling` record or as the terminal itself: an unhonored request survives so
 * a later settlement still sees it. The caller holds the project lock.
 */
export async function settleAttemptCancellationLocked(
  request: AttemptExecutionRequestV1, deliveredCancellation: boolean,
): Promise<void> {
  const { root, binding } = request;
  const requested = deliveredCancellation
    || await preparationCancellationRequested(root, binding.workspaceId, binding.runId);
  if (!requested) return;
  // Capture keys on the REQUEST, never on how the phase happened to settle. It
  // used to require a `cancelled` phase state, so every other way a leg can end
  // after a delivered cancel — the bounded deadline expiring, a leg fault, a leg
  // that finished anyway — recorded nothing at all, and stickiness fell back to
  // the advisory file surviving. That is the assumption this whole path exists to
  // remove. What the phase settled as is preserved either way: this records the
  // RUN-level `cancelling`, and no phase summary is touched.
  const captured = await recordDurableCancellingLocked(attemptSettlementInput(request));
  const settled = await settleCancelledRunLocked(attemptSettlementInput(request));
  // Drop the advisory only on the append that actually happened. Keying on the
  // ATTEMPT to record `cancelling` consumed the request even when the record was
  // never written — a read failure looked exactly like a capture — leaving the
  // operator's intent held nowhere at all.
  if (captured || settled.status === "settled") {
    await removePreparationCancelLocked(root, binding.workspaceId, binding.runId);
  }
}
