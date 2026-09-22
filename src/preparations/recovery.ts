/**
 * @file src/preparations/recovery.ts
 * @description Attempt recovery classification from DURABLE HOST FACTS (design
 * sections 16.4, 24.4). After a dead owner or crash the coordinator classifies
 * each unsettled attempt into exactly one of eight classes and never treats
 * process existence as proof: a dead PID does not prove a remote request did or
 * did not happen, so a broker effect is RE-OBSERVED through the injected broker
 * observer — never trusted from process memory. Classification is fail-closed and
 * ordered so the dangerous classes (unavailable, conflict, unknown effect)
 * dominate; `unavailable` is NEVER `not-started`, because only an absent or
 * proved-not-started fact may authorize first execution. A recoverable park is
 * durably written: the transition is appended and the execution owner is cleared
 * so the run is left recovery-required, not a running-with-owner zombie.
 */

import {
  appendHandoffTransitionLocked, appendPreparationTransitionLocked, appendProjectedTransitionLocked,
  handoffStartBinding, readPreparationRun, type PreparationRunContentProjector, type PreparationRunRead,
} from "./run-store.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import { LEGAL_EDGES, OWNER_ACTIVE_STATES } from "./run-validation.js";
import { preparationCancellationRequested, removePreparationCancelLocked } from "./cancellation.js";
import {
  ADVISORY_UNCONSUMED_RUN_STATES, CANCEL_SETTLEABLE_RUN_STATES,
  carryAdvisoryIntoCancellingLocked, handoffOwnsRunSettlement, settleCancelledRunLocked,
} from "./attempts/cancel-settlement.js";
import {
  projectLifecyclePending,
} from "./lifecycle-snapshot/compat.js";
import type { LifecyclePendingUnitV1 } from "./lifecycle-snapshot/compat.js";
import { upsertPhaseSummary } from "./attempts/start.js";
import { ownerFencesAttempt } from "./attempts/lease.js";
import { scanPreparationInventory } from "./capacity.js";
import { withPreparationLifecycleRead } from "./lifecycle-snapshot/read.js";
import { readPreparationKey } from "./key-epoch.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "./manifest-parse.js";
import { assertBundleId, assertOperationRunId } from "../operation-bundles/ids.js";
import { readOperationKey } from "../operation-bundles/key-epoch.js";
import { readOperationManifest } from "../operation-bundles/manifest-store.js";
import { operationManifestDigest } from "../operation-bundles/manifest-parse.js";
import { readOperationRun } from "../operation-bundles/run-store.js";
import { createdGenesisAuthorityDigest } from "./handoff-bundle.js";
import type { OperationBundleManifest } from "../operation-bundles/types.js";
import type { AttemptId, PhaseInstanceId } from "./ids.js";
import type { Sha256Digest } from "./types.js";
import type {
  AppendPreparationTransitionInput, PhaseSummaryV1, PreparationPrincipalV1,
  PreparationRunBinding, PreparationRunV1,
} from "./run-types.js";

/** The eight closed attempt recovery classes (design section 16.4). */
export type AttemptRecoveryClassification =
  | "not-started" | "checkpointed" | "result-custodied" | "failed-settled"
  | "effect-settled" | "outcome-unknown" | "unavailable" | "conflict";

/** The closed next move each classification authorizes (design section 16.4). */
export type RecoveryMove =
  | "start-new-attempt-if-policy-allows" | "resume" | "revalidate-and-commit"
  | "apply-retry-or-settle-failure" | "continue-without-duplicating"
  | "recovery-required-never-auto-retry" | "park" | "park-with-bounded-evidence";

/** The park-vs-deny durable read taxonomy (design section 24.4). */
export type DurableReadClass =
  | "absent" | "not-started" | "unavailable" | "conflict" | "outcome-unknown" | "integrity-invalid";

/** Effect outcomes proving a remote effect was applied. */
const APPLIED_EFFECTS = new Set(["applied", "already-applied"]);

/**
 * The durable host facts one attempt's recovery classifies from. `reObserved*`
 * fields MUST originate from a fresh broker re-observation (see
 * {@link reObserveEffects}) — never a receipt cached in process memory — so a
 * crashed attempt's in-memory belief cannot mask an applied or unknown effect.
 */
export interface AttemptRecoveryFactsV1 {
  readonly observationsAvailable: boolean;
  readonly conflict: boolean;
  readonly reObservedEffectOutcomes: readonly string[];
  readonly resultCustodyComplete: boolean;
  readonly checkpointResumable: boolean;
  readonly launchBoundaryCrossed: boolean | "unknown";
  readonly providerEnded: boolean;
}

/**
 * Classify one unsettled attempt. The ordering is fail-closed: a failed
 * observation, a conflict, or an unknown effect dominates every optimistic
 * signal; `not-started` is reached ONLY when the launch boundary is PROVABLY not
 * crossed; an unknown boundary can never become `not-started` and degrades to
 * `unavailable` unless the provider is proven ended with settled effects.
 */
export function classifyAttemptRecovery(facts: AttemptRecoveryFactsV1): AttemptRecoveryClassification {
  if (!facts.observationsAvailable) return "unavailable";
  if (facts.conflict) return "conflict";
  if (facts.reObservedEffectOutcomes.includes("outcome-unknown")) return "outcome-unknown";
  if (facts.reObservedEffectOutcomes.some((outcome) => APPLIED_EFFECTS.has(outcome))) return "effect-settled";
  if (facts.resultCustodyComplete) return "result-custodied";
  if (facts.checkpointResumable) return "checkpointed";
  if (facts.launchBoundaryCrossed === false) return "not-started";
  if (facts.providerEnded && facts.launchBoundaryCrossed === true) return "failed-settled";
  return "unavailable";
}

/** Map one classification to its authorized next move (design section 16.4). */
export function recoveryNextMove(classification: AttemptRecoveryClassification): RecoveryMove {
  switch (classification) {
    case "not-started": return "start-new-attempt-if-policy-allows";
    case "checkpointed": return "resume";
    case "result-custodied": return "revalidate-and-commit";
    case "failed-settled": return "apply-retry-or-settle-failure";
    case "effect-settled": return "continue-without-duplicating";
    case "outcome-unknown": return "recovery-required-never-auto-retry";
    case "conflict": return "park-with-bounded-evidence";
    default: return "park";
  }
}

/** Only an absent or proved-not-started durable read authorizes first execution. */
export function authorizesFirstExecution(readClass: DurableReadClass): boolean {
  return readClass === "absent" || readClass === "not-started";
}

/** Durable run states that already carry an operator cancellation. */
const CANCEL_RUN_STATES = new Set<PreparationRunV1["state"]>(["cancelling", "cancelled", "cancelled-with-effects"]);

/**
 * A recovering coordinator re-checks cancellation from BOTH the durable signed
 * run state and the advisory `.cancel` file (design section 23.2: "recovery also
 * checks the file"). A run already in a durable cancel state is cancelled
 * regardless of the advisory; otherwise a valid present advisory still signals an
 * operator cancel the coordinator must honor before ordinary continuation.
 */
export async function cancellationObservedForRecovery(root: string, run: PreparationRunV1): Promise<boolean> {
  if (CANCEL_RUN_STATES.has(run.state)) return true;
  return preparationCancellationRequested(root, run.workspaceId, run.runId);
}

/**
 * Map a not-ok durable run read into its park-vs-deny class. An existing OK run
 * is deliberately not mapped here: its state — never a bare read — decides
 * continuation, and it is never a first-execution authorization.
 */
export function recoveryReadClass(read: Exclude<PreparationRunRead, { status: "ok" }>): DurableReadClass {
  if (read.status === "absent") return "absent";
  return read.code === "run-integrity-invalid" ? "integrity-invalid" : "unavailable";
}

/** The result of re-observing a logical broker effect at recovery time. */
export interface BrokerEffectReObservationV1 {
  readonly status: "observed" | "unavailable" | "conflict";
  readonly outcomes: readonly string[];
}

/** A host port that RE-OBSERVES an attempt's broker effects at recovery time. */
export interface BrokerEffectReObserverV1 {
  reObserve(): Promise<BrokerEffectReObservationV1>;
}

/** The observation facts a re-observation contributes to a classification. */
export interface ReObservedEffectFactsV1 {
  readonly observationsAvailable: boolean;
  readonly conflict: boolean;
  readonly reObservedEffectOutcomes: readonly string[];
}

/**
 * Re-observe an attempt's broker effects through the injected observer and map
 * the outcome into classification facts. A thrown or `unavailable` observation
 * parks (never assumes not-started); a `conflict` observation parks with bounded
 * evidence. The recorded run receipt is intentionally not an input here: recovery
 * derives effect truth from a fresh broker observation, not process memory.
 */
export async function reObserveEffects(observer: BrokerEffectReObserverV1): Promise<ReObservedEffectFactsV1> {
  let observation: BrokerEffectReObservationV1;
  try {
    observation = await observer.reObserve();
  } catch {
    return { observationsAvailable: false, conflict: false, reObservedEffectOutcomes: [] };
  }
  if (observation.status === "unavailable") return { observationsAvailable: false, conflict: false, reObservedEffectOutcomes: [] };
  if (observation.status === "conflict") return { observationsAvailable: true, conflict: true, reObservedEffectOutcomes: [] };
  return { observationsAvailable: true, conflict: false, reObservedEffectOutcomes: observation.outcomes };
}

/** Clear the execution owner and mark one phase recovery-required. */
function recoveryParkProjector(phaseInstanceId: PhaseInstanceId): PreparationRunContentProjector {
  return (next) => {
    const { executionOwner: _cleared, ...rest } = next;
    const prior = next.phaseSummaries.find((summary) => summary.phaseInstanceId === phaseInstanceId);
    if (prior === undefined) return rest;
    const summary: PhaseSummaryV1 = { ...prior, state: "recovery-required" };
    return { ...rest, phaseSummaries: upsertPhaseSummary(next.phaseSummaries, summary) };
  };
}

/**
 * The states a stranded run may be PARKED from — DERIVED, never listed.
 *
 * The rule is "an owner-active state that no other recovery leg owns", and each
 * subtraction names the leg that owns it instead:
 *
 *  - `handoff-started` belongs to {@link recoverHandoffStartedLocked}, which
 *    settles or parks it against the Milestone A pair rather than on liveness.
 *  - the cancel-settleable states belong to the settlement, which advances them
 *    to their honest terminal.
 *
 * What remains is the set with an owner and no other owner: `running`, which
 * this has always parked, and `paused`/`awaiting-gate`, which had NO exit at
 * all. Both are owner-active, so the advisory custody leg subtracts them; both
 * are unstartable, so no attempt consumes a cancel; both are unsettleable, so
 * the settlement skips them; and `fail` is `planned`-only. Their edge to
 * `recovery-required` was legal the whole time and no shipped verb could
 * traverse it — one guard, not a missing state machine, which is why
 * `LEGAL_EDGES` is untouched.
 *
 * DERIVED SO THE NEXT WRITER INHERITS THE EXIT. `awaiting-gate` has no
 * production writer today; including it costs nothing and means whoever ships
 * one does not have to rediscover that the state is a dead end.
 */
export const PARKABLE_RUN_STATES: ReadonlySet<PreparationRunV1["state"]> = new Set(
  [...OWNER_ACTIVE_STATES].filter((state) =>
    state !== "handoff-started" && !CANCEL_SETTLEABLE_RUN_STATES.has(state)),
);

/**
 * Durably park an unrecoverable-without-work attempt: append the
 * `recovery-required` transition and clear the execution owner so the run is
 * left recovery-required rather than a zombie holding a fence nothing will
 * release. The caller holds the project lock.
 *
 * It mirrors `parkOnDrift`'s fail-closed guard: the durable owner must still
 * fence the exact `attemptId`/`leaseNonce` being recovered, so a run whose owner
 * was already cleared or rotated is rejected rather than force-moved. The
 * run-store predecessor authentication is a further check, not the only one.
 *
 * THE STATE SET IS DERIVED (see {@link PARKABLE_RUN_STATES}) rather than being
 * `running` alone. A `paused` run whose owner died had no exit by any shipped
 * verb — the sixth instance of the guard-that-strands class in this program, and
 * the one a `pause` verb would CREATE rather than inherit.
 */
export async function parkAttemptForRecoveryLocked(input: {
  root: string;
  binding: PreparationRunBinding;
  run: PreparationRunV1;
  phaseInstanceId: PhaseInstanceId;
  attemptId: AttemptId;
  leaseNonce: string;
  principal: PreparationPrincipalV1;
  at: string;
}): Promise<void> {
  if (!PARKABLE_RUN_STATES.has(input.run.state)
    || !ownerFencesAttempt(input.run.executionOwner, input.attemptId, input.leaseNonce)) {
    throw new Error("recovery park requires an owner-active run whose owner fences the recovered attempt");
  }
  const transition: AppendPreparationTransitionInput = {
    type: "recovery-required", stateAfter: "recovery-required",
    actor: { id: input.principal.id, surface: input.principal.surface }, at: input.at,
    payload: { kind: "problem", code: "preparation-integrity-obligation" },
  };
  await appendProjectedTransitionLocked(
    input.root, input.binding, preparationRunPredecessor(input.run), transition,
    recoveryParkProjector(input.phaseInstanceId),
  );
}

/** The principal recorded on an automatic preparation-recovery settlement. */
const RECOVERY_ACTOR: PreparationPrincipalV1 = { id: "recovery", surface: "recovery" };

/** The closed outcome of classifying one durable `handoff-started` run (design 22.4). */
type HandoffRecoveryOutcome = "settled" | "resume-required" | "parked" | "unavailable";

/** Park one interrupted handoff to recovery-required without duplicating or overwriting. */
async function parkHandoffLocked(root: string, binding: PreparationRunBinding, run: PreparationRunV1, at: string): Promise<void> {
  await appendPreparationTransitionLocked(root, binding, preparationRunPredecessor(run), {
    type: "recovery-required", stateAfter: "recovery-required", actor: RECOVERY_ACTOR, at,
    payload: { kind: "problem", code: "preparation-integrity-obligation" },
  });
}

/**
 * Classify one durable `handoff-started` run against the CURRENT Milestone A
 * state and settle it WITHOUT any external work (design section 22.4). The
 * reserved identities come only from the run's own durable authority. A bundle and
 * run that exactly match the recorded reserved binding are completed with
 * `handed-off`; a conflicting or half-created Milestone A pair parks; a wholly
 * absent pair is left for the handoff command to resume with its obligation set.
 * It never re-drives creation and never overwrites Milestone A bytes.
 */
async function recoverHandoffStartedLocked(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1, at: string,
): Promise<HandoffRecoveryOutcome> {
  const start = handoffStartBinding(run);
  if (start === undefined) { await parkHandoffLocked(root, binding, run, at); return "parked"; }
  const bundleId = assertBundleId(start.reservedBundleId);
  const manifest = await readOperationManifest(root, run.workspaceId, bundleId);
  if (manifest.status === "unavailable") return "unavailable";
  const present = manifest.status === "ok" ? manifest.manifest : undefined;
  if (present !== undefined) {
    const digest = operationManifestDigest(present) as typeof start.bundleManifestDigest;
    if (digest !== start.bundleManifestDigest || present.runId !== start.reservedOperationRunId) {
      await parkHandoffLocked(root, binding, run, at); return "parked";
    }
  }
  return classifyHandoffRun(root, binding, run, start, present, at);
}

/**
 * Resolve the Milestone A run leg of a handoff recovery once the manifest is
 * known. When both the manifest and the genesis run are present the reserved
 * bundle's genesis authority is re-derived from the AUTHENTICATED run and compared
 * to the digest the durable `handoff-started` record pinned: the manifest digest
 * is invariant to that authority, so a bundle staged under the reserved identity
 * with a divergent control budget or compensation topology PARKS rather than
 * settling handed-off — mirroring the command-path resume gate exactly.
 */
async function classifyHandoffRun(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1,
  start: NonNullable<ReturnType<typeof handoffStartBinding>>,
  manifest: OperationBundleManifest | undefined, at: string,
): Promise<HandoffRecoveryOutcome> {
  const key = await readOperationKey(root);
  if (key.status !== "ok") return "unavailable";
  const opRun = await readOperationRun(root, {
    runId: assertOperationRunId(start.reservedOperationRunId), bundleId: assertBundleId(start.reservedBundleId),
    manifestDigest: start.bundleManifestDigest, workspaceId: run.workspaceId, keyEpochId: key.keyEpochId,
  });
  if (opRun.status === "unavailable") return "unavailable";
  if (manifest !== undefined && opRun.status === "ok") {
    if (createdGenesisAuthorityDigest(opRun.run, manifest) !== start.genesisAuthorityDigest) {
      await parkHandoffLocked(root, binding, run, at); return "parked";
    }
    await appendHandoffTransitionLocked(root, binding, preparationRunPredecessor(run), { actor: RECOVERY_ACTOR, at });
    return "settled";
  }
  if (manifest === undefined && opRun.status !== "ok") return "resume-required";
  await parkHandoffLocked(root, binding, run, at); // manifest-without-run or run-without-manifest
  return "parked";
}

/** Enumerate every durably-readable preparation run under the current key epoch. */
async function enumeratePreparationRuns(
  root: string, manifests: readonly PreparationManifestV1[], keyEpochId: Sha256Digest,
): Promise<{ binding: PreparationRunBinding; run: PreparationRunV1 }[]> {
  const pairs: { binding: PreparationRunBinding; run: PreparationRunV1 }[] = [];
  for (const manifest of manifests) {
    const binding: PreparationRunBinding = {
      runId: manifest.runId, preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
      manifestDigest: preparationManifestDigest(manifest), keyEpochId,
    };
    const read = await readPreparationRun(root, binding);
    if (read.status === "ok") pairs.push({ binding, run: read.run });
  }
  return pairs;
}

/**
 * Re-drive one crash-interrupted CANCELLATION to its honest terminal (design
 * section 24.2, "advance a cancellation whose effects are fully observed").
 *
 * The executor settles the cancel it observed inside its own attempt; a crash
 * between the durable `cancelling` record and the terminal — or a mid-flight
 * cancel that parked `recovery-required` because an effect might have applied —
 * leaves a run with NO writer to advance it. This is that writer.
 *
 * The candidate states come from the settlement's own exported set, so the guard
 * here and the executor it calls can never disagree about what is settleable. A
 * `recovery-required` run additionally needs the cancel to be OBSERVED — the same
 * durable-state-or-advisory check the rest of recovery uses — so an ordinary park
 * is never force-moved onto a cancel terminal. Settlement itself writes nothing
 * unless the terminal is provable, so a blocked or unavailable classification
 * leaves the run exactly where it is, recoverable.
 *
 * The consumed advisory is dropped only once the terminal is durably recorded;
 * an unhonored request survives so a later settlement still sees it.
 */
async function settleCancelledRunForRecovery(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1, at: string,
): Promise<void> {
  if (!await cancellationObservedForRecovery(root, run)) return;
  // THE HANDOFF OWNS THIS RUN, read through the one shared predicate rather than
  // a third copy of it. Its bundle lives outside this run's effect ledger, so the
  // settlement's effect-freeness proof — which reads preparation-phase
  // declarations only — would prove "no phase can mutate" for a run that already
  // handed durable state to another authority.
  //
  // THE ADVISORY IS COLLECTED RATHER THAN LEFT, and that is the half this leg was
  // missing. Returning silently left an operator request over a run no settlement
  // will ever advance and that the terminal residue collector never sees, because
  // the dispatch sends a `recovery-required` run here and not there. Nothing can
  // honour it, so leaving it in place is a pending-request claim that is false.
  // The publishing surface refuses a fresh request over such a run and says the
  // handoff owns it, so the operator learns the truth rather than inferring it
  // from a file that quietly disappeared.
  if (handoffOwnsRunSettlement(run)) {
    await removePreparationCancelLocked(root, run.workspaceId, run.runId);
    return;
  }
  const settled = await settleCancelledRunLocked({ root, binding, principal: RECOVERY_ACTOR, at });
  if (settled.status === "settled") await removePreparationCancelLocked(root, run.workspaceId, run.runId);
}

/**
 * Collect a cancellation request left over a run that can never honor it.
 *
 * A TERMINAL RUN IS ONE NOTHING CAN MOVE — derived as a state with no outgoing
 * legal edge, so no settlement of any kind can ever consume an advisory beside
 * it. Such a request is not intent awaiting a writer; it is residue, and leaving
 * it there means an operator was truthfully told "cancellation requested" about a
 * file that would sit in the runs tree forever.
 *
 * IT IS REACHABLE WITHOUT ANYONE DOING ANYTHING WRONG. The cancel operation's
 * terminal check is a pre-write observation taken under NO LOCK — that is the
 * whole design of the lock-free request — so a `fail` (or any settlement) landing
 * between that check and the create-only write leaves exactly this state. The
 * window cannot be closed at the writing end without giving cancel a lock and
 * losing the property it exists for, so it is closed at the collecting end
 * instead, by the coordinator that already walks every run under the lock.
 *
 * WHY REMOVAL DISCARDS NO HONORABLE INTENT — and the honest reason is NOT the
 * one this comment first gave. It said a terminal state admits no transition, so
 * nothing could ever act on the request. THAT IS FALSE: `assertLegalEdge` early-
 * returns for the annotation types before it consults `LEGAL_EDGES`, and only
 * `warning-recorded` is blocked after a terminal — so `notice-recorded` is legal
 * from EVERY terminal state, and `run-validation.ts`'s own header names the
 * intended code for exactly this situation,
 * `cancellation-arrived-after-completion` "on an already-succeeded or handed-off
 * run". The state machine already permits the very thing the argument claimed it
 * forbade.
 *
 * The real reason is narrower and is a fact about TODAY: no writer of that
 * notice exists anywhere in the tree, so nothing observes this advisory and
 * nothing will. That is a statement with an expiry date, which is why it is
 * written here rather than assumed.
 *
 * IF THAT NOTICE IS EVER IMPLEMENTED, THIS LEG MUST MOVE FIRST. It runs on every
 * gated acquisition, so it would consume the evidence the notice writer is
 * looking for, silently and before that writer ever ran. The fix then is to
 * record the notice here rather than to keep collecting ahead of it.
 */
async function collectTerminalCancelResidue(
  root: string, run: PreparationRunV1,
): Promise<void> {
  if (LEGAL_EDGES[run.state].size > 0) return;
  if (!await preparationCancellationRequested(root, run.workspaceId, run.runId)) return;
  await removePreparationCancelLocked(root, run.workspaceId, run.runId);
}

/**
 * Settle one enumerated run's outstanding recovery obligation, fault-isolated.
 *
 * The dispatch is an explicit membership test on each leg's OWN state set, not a
 * binary else: a run in neither set has no obligation this leg owns, and routing
 * it to the cancellation leg by default would silently widen that leg's scope the
 * next time a run state is added.
 *
 * A FAILURE SETTLING ONE RUN MUST NOT STRAND THE OTHERS. Both legs classify
 * rather than throw for every state they can observe, but the durable append at
 * the end of each is real I/O and can still fail — a full disk, a revoked
 * permission, a byte budget. This leg runs INSIDE the lock acquisition of an
 * unrelated mutation, so an escaping failure would refuse that mutation and, once
 * an earlier run in the pass had already settled, leave the project mutated by an
 * acquisition the caller was told did not proceed. Skipping is safe because every
 * settlement here is idempotent and its append atomic: the skipped run is
 * re-driven on the next acquisition with no half-written state to reconcile.
 */
async function settleRunRecoveryLocked(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1, at: string,
): Promise<void> {
  try {
    if (run.state === "handoff-started") await recoverHandoffStartedLocked(root, binding, run, at);
    else if (CANCEL_SETTLEABLE_RUN_STATES.has(run.state)) await settleCancelledRunForRecovery(root, binding, run, at);
    // THE CUSTODY LEG. A run whose state can still accept the cancel but that no
    // consumer covers — derived, and today exactly `handoff-ready` — is carried
    // into `cancelling` so the settlement leg above owns it on the next pass.
    // Without it the operator's request sat over a run nothing would ever cancel
    // while the handoff command refused on that same request forever.
    else if (ADVISORY_UNCONSUMED_RUN_STATES.has(run.state)) {
      await carryAdvisoryIntoCancellingLocked({ root, binding, principal: RECOVERY_ACTOR, at });
    }
    // A FOURTH LEG. Reaching it does NOT mean the run is terminal — `planned`,
    // `running` and `paused` land here too — so the branch structure decides
    // nothing and the derived `LEGAL_EDGES` guard inside is what actually
    // selects the terminal runs. Written as an `else` only to keep the dispatch
    // one chain; an earlier comment credited this position with a filter it does
    // not perform.
    else await collectTerminalCancelResidue(root, run);
  } catch {
    // Deliberately skipped, not swallowed-and-forgotten: the run keeps its durable
    // obligation and the next gated acquisition re-drives it. Nothing here has
    // committed work that a later pass could roll back.
  }
}

/**
 * The gate's preparation-recovery leg: settle every completable handoff and every
 * crash-interrupted cancellation WITHOUT blocking unrelated work. It runs AFTER
 * Milestone A recovery so a bundle create that outran its preparation transition
 * is discovered and completed with `handed-off` rather than duplicated (design
 * section 15.1); a conflicting half-created pair is parked. It deliberately does
 * NOT block on a parked or bundle-absent in-flight handoff: those obligations
 * belong to their own command's resume and never conflict with an unrelated
 * mutation, so blanket blocking would wrongly stall concurrent preparation
 * execution. Unreadable inventory or key state is skipped — nothing can be settled
 * honestly there, and the immutable Milestone A bundle carries its own review
 * authority regardless.
 *
 * ONE UNSETTLEABLE RUN NEVER STRANDS THE REST — enforced by
 * {@link settleRunRecoveryLocked}, which classifies what it can and isolates the
 * durable append's own failures so the iteration always reaches the runs behind a
 * run it could not advance.
 */
export async function settlePreparationHandoffsLocked(root: string): Promise<void> {
  const inventory = await scanPreparationInventory(root);
  if (inventory.problems.length > 0 || inventory.manifests.length === 0) return;
  const key = await readPreparationKey(root);
  if (key.status !== "ok") return;
  const at = new Date().toISOString();
  for (const { binding, run } of await enumeratePreparationRuns(root, inventory.manifests, key.keyEpochId)) {
    await settleRunRecoveryLocked(root, binding, run, at);
  }
}

// Reported inside the state below, so a consumer must be able to name what it
// reads off a pending unit.
export type { LifecyclePendingUnitV1 } from "./lifecycle-snapshot/compat.js";

/**
 * The read-only lifecycle-maintenance state a status/gate surface reports (design 25.4).
 *
 * `registries` names the physical registries whose observation could not be
 * trusted. It is EMPTY when the origin is unattributable — a capture that failed
 * before any snapshot existed, or an incomplete snapshot naming no registry — and
 * an empty set must never be read as "confined to something harmless".
 */
export type PreparationLifecyclePendingState =
  | { status: "clean" }
  | {
    status: "pending";
    units: readonly LifecyclePendingUnitV1[];
    /**
     * Registries that could not be trusted DESPITE the pending work, because
     * the two facts co-occur and only one of them can be the status. A
     * destructive consumer must refuse on this whether or not it owns a unit.
     */
    unobservableRegistries: readonly ("quarantine" | "prune")[];
    /**
     * Whether the observation was COMPLETE. Not subsumed by the registry set:
     * a UNIT-level fault leaves the registry readable and attributes nothing,
     * so a consumer that must prove it saw everything reads both.
     */
    complete: boolean;
    /**
     * Every registry named by any problem behind this observation; empty when
     * the incompleteness could not be attributed. `complete` says an
     * observation was partial, not WHERE, and a consumer that must not strand
     * needs where.
     */
    problemRegistries: readonly ("quarantine" | "prune")[];
  }
  | {
    status: "unavailable";
    detail: string;
    registries: readonly ("quarantine" | "prune")[];
  };

/**
 * Report which two-phase quarantine/reset units are UNSETTLED without mutating any
 * bytes. A unit with a planned receipt but no completed one, or a reset-intent
 * marker with no completed receipt, is pending: unlike ordinary handoff settlement
 * it is NEVER auto-resumed here — only the same explicitly-confirmed destructive
 * command may resume it (design section 25.4).
 *
 * CONSUMED BY THE MUTATION RECOVERY GATE. `lock-gate.ts` calls this on every
 * non-`recovery` lock acquisition and refuses a pending or unreadable result, so a
 * half-finished destructive operation is no longer raced by an unrelated mutation
 * while its resumption stays with the owning command.
 *
 * The joined STATUS consumer named above still does not exist: nothing under
 * `src/commands/` renders this projection, and wiring that surface is remaining
 * Task 10 work. Only the gate consumer is real today.
 */
export async function resolvePreparationLifecyclePending(root: string): Promise<PreparationLifecyclePendingState> {
  try {
    // One callback-scoped capture delegating to a pure projector: the projector
    // performs no scan of its own, so this decision cannot observe two states.
    // Both failure legs report NO registries: a capture that never produced a
    // snapshot cannot attribute the fault to one registry, so the origin is
    // unknown rather than confined. Naming a registry here would be a guess that
    // a consumer could act on.
    return await withPreparationLifecycleRead(root, (read) => (read.status === "unavailable"
      ? { status: "unavailable" as const, detail: read.detail, registries: [] }
      : projectLifecyclePending(read.snapshot)));
  } catch (error) {
    return { status: "unavailable", detail: (error as Error).message, registries: [] };
  }
}
