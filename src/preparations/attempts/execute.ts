/**
 * @file src/preparations/attempts/execute.ts
 * @description The lease-fenced three-leg phase-attempt orchestrator (design
 * section 15.2). Under the project lock it re-reads, resolves the authority from
 * AUTHORITATIVE CURRENT state through the injected host-owned resolver, SEALS
 * that snapshot, and writes `intent-recorded` plus the execution owner; it then
 * RELEASES the lock before any provider/host/custody work runs; finally it
 * reacquires the lock, RE-RESOLVES the authority from current state, and commits
 * ONLY when the lease, run state, and the re-resolved authority snapshot still
 * match — any drift discards the late result fail-closed. The executor, gate,
 * bounds, and disposition are read from the IMMUTABLE sealed plan phase, never
 * from the caller, so a caller cannot substitute a weaker executor, drop a gate,
 * or supply the digests it is checked against (design section 15.3). No provider,
 * broker, handler, or custody work executes while the project lock is held.
 */

import { withOrdinaryMutationLock as underLock } from "../../operation-bundles/with-mutation-lock.js";
import { LockBusyError } from "../../utils/lock.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import { externalEffectReceiptDigest } from "../../capability-providers/brokers/receipts.js";
import { captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { deriveAttemptId, type AttemptId, type PhaseInstanceId } from "../ids.js";
import { readPreparationManifest } from "../manifest-store.js";
import { preparationRunPredecessor } from "../run-integrity.js";
import { appendProjectedTransitionLocked, readPreparationRun } from "../run-store.js";
import { settleAttemptCancellationLocked } from "./cancel-settlement.js";
import { runAttemptLeg, type AttemptLegDeliveryV1 } from "./cancel-delivery.js";
import type { PreparationManifestV1 } from "../manifest-parse.js";
import type { NormalizedPhaseV1, PhaseExecutorV1 } from "../plan-types.js";
import type {
  AppendPreparationTransitionInput, EffectSummaryV1, PhaseSummaryV1,
  PreparationRunBinding, PreparationPrincipalV1, PreparationRunProblemCode, PreparationRunV1,
} from "../run-types.js";
import type { PreparationRunContentProjector } from "../run-store.js";
import { authoritySnapshotDigest, computeSealedAuthority, sealAttemptContext, upsertPhaseSummary, attemptIntentProjector } from "./start.js";
import { mintAttemptLease, ownerFencesAttempt, ownerProcessIsLive } from "./lease.js";
import { discardCustody, publishCustodyLocked } from "./custody.js";
import type { PreparationEvidenceLocation } from "../evidence-store.js";
import { ATTEMPT_STARTABLE_RUN_STATES } from "./types.js";
import type {
  AttemptAuthorityResolverV1, AttemptClockV1, AttemptEffectObservationV1, AttemptExecutionRequestV1,
  AttemptLegOutcomeV1, AttemptLegRunnerV1, AttemptOutcomeV1, SealAuthorityExtrasV1, SealedAttemptContextV1,
} from "./types.js";

/** The one park reason a CANCELLATION produces; see {@link parkProblemCode}. */
const CANCEL_EFFECT_UNCERTAIN = "cancel-effect-uncertain";
/**
 * The park reason a required leg's own FAULT records — an unknown-state leg,
 * which retry refuses.
 */
const LEG_FAULT_PARK = "leg-fault";

/** External-effect outcomes that cannot land without honest recording (a later task). */
const APPLIED_OR_UNKNOWN_EFFECTS = new Set(["applied", "already-applied", "outcome-unknown"]);

/** Require a non-empty string, translating a hostile value into refusal. */
function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("attempt request field is not a string");
  return value;
}

/**
 * Capture the request into a frozen, accessor-rejecting, data-only snapshot with
 * the security-relevant collaborators (resolver, leg, clock) bound by reference
 * ONCE — taken BEFORE the first await. The seal AND leg-K revalidate read only
 * from this snapshot, so a caller-controlled leg cannot swap the authority
 * resolver, run binding, or clock mid-attempt to force a commit (design 15.3).
 */
function captureRequest(input: AttemptExecutionRequestV1): AttemptExecutionRequestV1 {
  const top = captureOwnDataRecord(input);
  const binding = captureOwnDataRecord(top.binding);
  const principal = captureOwnDataRecord(top.principal);
  const resolver = top.authorityResolver as AttemptAuthorityResolverV1;
  const clock = top.clock as AttemptClockV1;
  return Object.freeze({
    root: requireString(top.root),
    binding: Object.freeze({
      runId: binding.runId, preparationId: binding.preparationId, manifestDigest: binding.manifestDigest,
      workspaceId: binding.workspaceId, keyEpochId: binding.keyEpochId,
    }) as PreparationRunBinding,
    phaseInstanceId: top.phaseInstanceId as PhaseInstanceId,
    logicalPhaseId: requireString(top.logicalPhaseId), attemptIndex: top.attemptIndex as number,
    // Bind the collaborator CALLABLES once, so a swapped `resolve`/`now` after the
    // await cannot change what the commit path invokes.
    authorityResolver: { resolve: resolver.resolve.bind(resolver) },
    leg: top.leg as AttemptLegRunnerV1,
    principal: Object.freeze({ id: principal.id, surface: principal.surface }) as PreparationPrincipalV1,
    clock: { now: clock.now.bind(clock) },
  });
}

/** The preparation evidence destination for one attempt's captured binding. */
function evidenceLocationOf(request: AttemptExecutionRequestV1): PreparationEvidenceLocation {
  return { workspaceId: request.binding.workspaceId, preparationId: request.binding.preparationId };
}

/** One work phase proven to carry an executor. */
type ExecutablePhase = NormalizedPhaseV1 & { executor: PhaseExecutorV1 };

/** A not-ok run read; its finer typed code is surfaced so a transient and an
 * integrity-invalid run never collapse to the same opaque park reason. */
type RunReadNotOk = Exclude<Awaited<ReturnType<typeof readPreparationRun>>, { status: "ok" }>;

/** Emit an optional field only when defined. */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** Surface the finer run-read code (integrity-invalid stays distinct from absent). */
function runReason(read: RunReadNotOk): string {
  return read.status === "unavailable" ? `run-${read.code}` : "run-absent";
}

// --- Leg A–E: seal and record intent under the project lock --------------

/**
 * A defensively-snapshotted, format-validated copy of resolved authority digests.
 * Exported so every attempt-shaped execution — including the no-durable-write
 * ephemeral read — validates a resolver's output through this ONE snapshot.
 */
export function snapshotSealAuthorityExtras(extras: SealAuthorityExtrasV1): SealAuthorityExtrasV1 {
  const digest = (value: string | undefined) => (value === undefined ? undefined : parseSha256Digest(value));
  return {
    inputExposureSetDigest: parseSha256Digest(extras.inputExposureSetDigest),
    ...optional("grantSnapshotDigest", digest(extras.grantSnapshotDigest)),
    ...optional("providerPinDigest", digest(extras.providerPinDigest)),
    ...optional("effectPlanDigest", digest(extras.effectPlanDigest)),
    ...optional("brokerPlanDigest", digest(extras.brokerPlanDigest)),
    ...optional("backendReadinessDigest", digest(extras.backendReadinessDigest)),
  };
}

type IntentResult =
  | { kind: "sealed"; sealed: SealedAttemptContextV1 }
  | { kind: "done"; outcome: AttemptOutcomeV1 };

type PhaseLookup =
  | { kind: "ok"; phase: ExecutablePhase }
  | { kind: "done"; outcome: AttemptOutcomeV1 };

/**
 * Resolve the sealed plan phase named by `logicalPhaseId`. The gate, executor,
 * and bounds are read here from the immutable plan — a phase carrying a gate is
 * blocked, and a phase with no executor cannot be run as an attempt.
 */
function findExecutablePhase(manifest: PreparationManifestV1, logicalPhaseId: string): PhaseLookup {
  const phase = manifest.plan.phases.find((candidate) => candidate.logicalPhaseId === logicalPhaseId);
  if (phase === undefined) return { kind: "done", outcome: { status: "parked", reason: "phase-not-in-plan" } };
  if (phase.gate !== undefined) return { kind: "done", outcome: { status: "blocked", reason: "gate-unresolved" } };
  if (phase.executor === undefined) return { kind: "done", outcome: { status: "parked", reason: "phase-has-no-executor" } };
  return { kind: "ok", phase: phase as ExecutablePhase };
}

type ExtrasResolution =
  | { kind: "ok"; extras: SealAuthorityExtrasV1 }
  | { kind: "unavailable"; reason: string };

/** Resolve authority extras from authoritative current state, failing closed. */
async function resolveAuthorityExtras(request: AttemptExecutionRequestV1, phase: ExecutablePhase): Promise<ExtrasResolution> {
  try {
    const resolution = await request.authorityResolver.resolve({
      executor: phase.executor, phaseInstanceId: request.phaseInstanceId, logicalPhaseId: phase.logicalPhaseId,
    });
    if (resolution.status !== "ok") return { kind: "unavailable", reason: `authority-${resolution.reason}` };
    return { kind: "ok", extras: snapshotSealAuthorityExtras(resolution.extras) };
  } catch {
    return { kind: "unavailable", reason: "authority-resolver-fault" };
  }
}

type PreparedIntent =
  | { kind: "ready"; run: PreparationRunV1; manifest: PreparationManifestV1; phase: ExecutablePhase }
  | { kind: "done"; outcome: AttemptOutcomeV1 };

/** Run every read-only precondition: run readable/startable, plan phase, and guard. */
async function prepareIntent(request: AttemptExecutionRequestV1): Promise<PreparedIntent> {
  const read = await readPreparationRun(request.root, request.binding);
  if (read.status !== "ok") return { kind: "done", outcome: { status: "parked", reason: runReason(read) } };
  // Through the exported set, so the sweep that derives "which states leave a
  // cancellation advisory with no consumer" reads the same enumeration this
  // precondition enforces rather than a copy of it.
  if (!ATTEMPT_STARTABLE_RUN_STATES.has(read.run.state)) {
    return { kind: "done", outcome: { status: "parked", reason: `run-not-startable-${read.run.state}` } };
  }
  const manifest = await readManifest(request);
  if (manifest === null) return { kind: "done", outcome: { status: "parked", reason: "manifest-unavailable" } };
  const lookup = findExecutablePhase(manifest, request.logicalPhaseId);
  if (lookup.kind === "done") return lookup;
  if (request.attemptIndex < 0 || request.attemptIndex >= lookup.phase.bounds.maximumAttempts) {
    return { kind: "done", outcome: { status: "parked", reason: "attempt-bound-exceeded" } };
  }
  const guard = startGuard(request, read.run);
  return guard !== null ? { kind: "done", outcome: guard } : { kind: "ready", run: read.run, manifest, phase: lookup.phase };
}

/** Recover, seal, and durably record the attempt intent while holding the lock. */
async function recordIntent(request: AttemptExecutionRequestV1): Promise<IntentResult> {
  const prepared = await prepareIntent(request);
  if (prepared.kind === "done") return done(prepared.outcome);
  const resolved = await resolveAuthorityExtras(request, prepared.phase);
  if (resolved.kind !== "ok") return done({ status: "parked", reason: resolved.reason });
  const attemptId = deriveAttemptId(request.phaseInstanceId, request.attemptIndex);
  const sealed = seal(request, prepared.manifest, prepared.phase, attemptId, resolved.extras, prepared.run.stateVersion);
  await writeIntent(request, prepared.run, sealed);
  return { kind: "sealed", sealed };
}

/** Read the immutable manifest bound to the run, or null when unavailable. */
async function readManifest(request: AttemptExecutionRequestV1): Promise<PreparationManifestV1 | null> {
  const read = await readPreparationManifest(request.root, request.binding.workspaceId, request.binding.preparationId);
  return read.status === "ok" ? read.manifest : null;
}

/**
 * Refuse a second attempt when one is already in flight (a live execution owner)
 * and park when a prior owner is dead or the phase already reached a
 * non-restartable state; only a provably absent or failed/cancelled phase starts.
 */
function startGuard(request: AttemptExecutionRequestV1, run: PreparationRunV1): AttemptOutcomeV1 | null {
  const owner = run.executionOwner;
  if (owner !== undefined) {
    return ownerProcessIsLive(owner) ? { status: "refused-busy" } : { status: "parked", reason: "recovery-required-dead-owner" };
  }
  const prior = run.phaseSummaries.find((summary) => summary.phaseInstanceId === request.phaseInstanceId);
  if (prior !== undefined && prior.state !== "failed" && prior.state !== "cancelled") {
    return { status: "parked", reason: `phase-not-startable-${prior.state}` };
  }
  return null;
}

/** Seal the exact authority snapshot from the sealed plan phase and resolved extras. */
function seal(
  request: AttemptExecutionRequestV1, manifest: PreparationManifestV1, phase: ExecutablePhase,
  attemptId: AttemptId, extras: SealAuthorityExtrasV1, stateVersion: number,
): SealedAttemptContextV1 {
  return sealAttemptContext({
    manifest, executor: phase.executor, bounds: phase.bounds, extras, attemptId,
    phaseInstanceId: request.phaseInstanceId, logicalPhaseId: phase.logicalPhaseId,
    disposition: phase.disposition, lease: mintAttemptLease(request.clock.now()), stateVersionAtSeal: stateVersion,
  });
}

/** Durably append the phase-started transition, execution owner, and phase summary. */
async function writeIntent(request: AttemptExecutionRequestV1, run: PreparationRunV1, sealed: SealedAttemptContextV1): Promise<void> {
  const priorPhase = run.phaseSummaries.find((summary) => summary.phaseInstanceId === request.phaseInstanceId);
  const attemptCount = (priorPhase?.attemptCount ?? 0) + 1;
  const input: AppendPreparationTransitionInput = {
    type: "phase-started", stateAfter: "running", actor: { id: request.principal.id, surface: request.principal.surface },
    at: request.clock.now(), payload: { kind: "phase", phaseInstanceId: sealed.phaseInstanceId, phaseState: "running" },
  };
  await appendProjectedTransitionLocked(request.root, request.binding, preparationRunPredecessor(run), input, attemptIntentProjector(sealed, attemptCount));
}

function done(outcome: AttemptOutcomeV1): IntentResult { return { kind: "done", outcome }; }

// --- Leg F–H: run the leg with the lock RELEASED ------------------------
// Owned by {@link file://./cancel-delivery.ts}: the pre-launch boundary check,
// the executor-owned cancellation signal and its advisory poll, the leg call,
// and the bounded post-delivery deadline. It touches no lock and no durable
// state, which is exactly why it lives outside this orchestrator.

// --- Leg I–L: revalidate and commit under the project lock --------------

/** Compare one observed pin/grant pair against the sealed authority. */
function pinGrantDrift(
  sealed: SealedAttemptContextV1, observedPin: string | undefined, observedGrant: string | undefined,
): "provider-pin-drift" | "grant-drift" | null {
  const pin = sealed.authority.providerPinDigest;
  const grant = sealed.authority.grantSnapshotDigest;
  if (pin !== undefined && observedPin !== undefined && observedPin !== pin) return "provider-pin-drift";
  if (grant !== undefined && observedGrant !== undefined && observedGrant !== grant) return "grant-drift";
  return null;
}

/** Detect provider-pin, grant, or backend-readiness drift observed during the leg. */
function observedDrift(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): string | null {
  const backend = sealed.authority.backendReadinessDigest;
  if (backend !== undefined && outcome.observedBackendReadinessDigest !== undefined && outcome.observedBackendReadinessDigest !== backend) {
    return "backend-readiness-drift";
  }
  const top = pinGrantDrift(sealed, outcome.observedProviderPinDigest, outcome.observedGrantSnapshotDigest);
  if (top !== null) return top;
  for (const { receipt } of outcome.effects) {
    const drift = pinGrantDrift(sealed, receipt.providerPinDigest, receipt.grantSnapshotDigest);
    if (drift !== null) return `receipt-${drift}`;
  }
  return null;
}

/**
 * Re-verify lease and run state, then RE-RESOLVE the authority from current state
 * and compare its snapshot to the sealed one. Re-resolution (not a recompute over
 * the sealed values) is what makes the gate detect a genuine pin/grant/effect/
 * broker drift on a receiptless phase (design section 15.3).
 */
async function revalidate(request: AttemptExecutionRequestV1, sealed: SealedAttemptContextV1, run: PreparationRunV1): Promise<string | null> {
  if (!ownerFencesAttempt(run.executionOwner, sealed.attemptId, sealed.lease.leaseNonce)) return "lease-drift";
  if (run.state !== "running") return `run-not-running-${run.state}`;
  const manifest = await readManifest(request);
  if (manifest === null) return "manifest-unavailable";
  const lookup = findExecutablePhase(manifest, sealed.logicalPhaseId);
  if (lookup.kind !== "ok") return "phase-drift";
  const resolved = await resolveAuthorityExtras(request, lookup.phase);
  if (resolved.kind !== "ok") return resolved.reason;
  const current = authoritySnapshotDigest(computeSealedAuthority(manifest, sealed.executor, resolved.extras));
  return current === sealed.authoritySnapshotDigest ? null : "authority-drift";
}

type EffectRecording =
  | { safe: true; effects: readonly EffectSummaryV1[] }
  | { safe: false; reason: string };

/** Record benign external effects honestly; park on any applied/unknown effect. */
function recordEffects(attemptId: AttemptId, observations: readonly AttemptEffectObservationV1[]): EffectRecording {
  if (observations.some((observation) => APPLIED_OR_UNKNOWN_EFFECTS.has(observation.receipt.outcome))) {
    return { safe: false, reason: "external-effect-unrecorded" };
  }
  const effects = observations.map((observation): EffectSummaryV1 => ({
    attemptId, effectIndex: observation.effectIndex, outcome: observation.receipt.outcome,
    receiptDigest: externalEffectReceiptDigest(observation.receipt),
  }));
  return { safe: true, effects };
}

/** A leg outcome that is committed as succeeded and so must fit every ceiling. */
function isSuccessOutcome(outcome: AttemptLegOutcomeV1): boolean {
  return outcome.phaseState === "succeeded" || outcome.phaseState === "succeeded-with-warnings";
}

/**
 * A cancellation delivered MID-FLIGHT (the leg actually ran, invocationCount > 0)
 * to an EFFECT-CAPABLE phase (maximumEffectsPerAttempt > 0) cannot prove no
 * mutating external effect applied before the backend honored the cancel — a
 * cancelled provider result does not surface its in-flight receipts. Such an
 * outcome fails closed to `recovery-required` rather than a false `cancelled`
 * (design section 23.2). A pre-launch cancel (invocationCount 0) and an
 * effect-free phase (maximumEffectsPerAttempt 0) are provably effect-free and
 * settle `cancelled` honestly.
 */
function cancelEffectUncertain(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): string | null {
  if (outcome.phaseState !== "cancelled") return null;
  return outcome.invocationCount > 0 && sealed.bounds.maximumEffectsPerAttempt > 0 ? CANCEL_EFFECT_UNCERTAIN : null;
}

/**
 * A MEASURED usage dimension proven above its sealed ceiling. This is a breach
 * the host observed, not an unproven compliance claim, so it holds for EVERY
 * outcome — a failed or cancelled attempt that burned more than the phase was
 * authorized to spend overran its budget just as a successful one would, and
 * committing it as ordinary settled work would let the overrun settle silently
 * and reach a later retry preview as fact. An unobserved dimension is handled
 * separately (see {@link boundsViolation}): it is a missing proof, not a breach.
 */
function usageExceedsCeiling(usage: number | "unobserved", ceiling: number, dimension: string): string | null {
  if (usage === "unobserved") return null;
  return usage > ceiling ? `${dimension}-exceed-sealed-bound` : null;
}

/** Every measured usage dimension proven above its sealed ceiling, or null. */
function usageBreach(bounds: SealedAttemptContextV1["bounds"], outcome: AttemptLegOutcomeV1): string | null {
  return usageExceedsCeiling(outcome.tokenCount, bounds.maximumTokensPerAttempt, "tokens")
    ?? usageExceedsCeiling(outcome.costMicros, bounds.maximumCostMicrosPerAttempt, "cost");
}

/**
 * Fail closed on an UNPROVEN usage dimension. An `"unobserved"` value means the
 * dimension is APPLICABLE (the capability could consume it) but the runtime did
 * not meter it, so it can never be proven within ANY hard limit (including 0). A
 * proven non-applicable dimension arrives as a measured 0 and passes. This is a
 * success-only check: only a commit as succeeded asserts the attempt stayed
 * within its ceilings, so only a commit needs the proof.
 */
function usageUnproven(outcome: AttemptLegOutcomeV1): string | null {
  if (outcome.tokenCount === "unobserved") return "tokens-unobserved";
  return outcome.costMicros === "unobserved" ? "cost-unobserved" : null;
}

/**
 * Reject a leg outcome that exceeds a sealed phase resource ceiling.
 *
 * A MEASURED token/cost overrun is checked on every outcome; the remaining
 * ceilings — per-object and aggregate output bytes, invocation, broker-request,
 * and effect counts — plus the unobserved-dimension proof apply only to a SUCCESS
 * outcome, whose commit is the claim that the attempt stayed in bounds (RC-B).
 * Exported so the ephemeral read enforces the SAME ceilings before projecting a
 * result, rather than cloning a second, weaker ceiling check.
 */
export function boundsViolation(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): string | null {
  const b = sealed.bounds;
  const breach = usageBreach(b, outcome);
  if (breach !== null) return breach;
  if (!isSuccessOutcome(outcome)) return null;
  const aggregate = outcome.pendingEvidence.reduce((sum, item) => sum + item.ref.byteCount, 0);
  if (outcome.pendingEvidence.some((item) => item.ref.byteCount > b.maximumOutputEvidenceBytes)) return "output-bytes-exceed-sealed-bound";
  if (aggregate > b.maximumOutputEvidenceBytes) return "aggregate-output-bytes-exceed-sealed-bound";
  if (outcome.invocationCount > b.maximumInvocationsPerAttempt) return "invocations-exceed-sealed-bound";
  if (outcome.brokerRequestCount > b.maximumBrokerRequestsPerAttempt) return "broker-requests-exceed-sealed-bound";
  if (outcome.effects.length > b.maximumEffectsPerAttempt) return "effects-exceed-sealed-bound";
  return usageUnproven(outcome);
}

/** Commit the honest outcome, or durably park when a check fails closed. */
/**
 * The park reason that blocks settlement, or null when the outcome may settle.
 * ORDER IS THE CONTRACT: authority revalidation first (a drifted authority
 * invalidates everything measured under it), then observed drift, then the
 * bounds violation, then an unprovable cancellation.
 */
async function preSettlementBlocker(
  request: AttemptExecutionRequestV1, sealed: SealedAttemptContextV1,
  run: PreparationRunV1, outcome: AttemptLegOutcomeV1,
): Promise<string | null> {
  return (await revalidate(request, sealed, run)) ?? observedDrift(sealed, outcome)
    ?? boundsViolation(sealed, outcome) ?? cancelEffectUncertain(sealed, outcome);
}

async function commitOutcome(
  request: AttemptExecutionRequestV1, sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1,
  cancellationObserved: boolean,
): Promise<AttemptOutcomeV1> {
  const read = await readPreparationRun(request.root, request.binding);
  if (read.status !== "ok") return { status: "parked", reason: runReason(read) };
  const reason = await preSettlementBlocker(request, sealed, read.run, outcome);
  if (reason !== null) return parkOnDrift(request, read.run, sealed, outcome, reason);
  const effect = recordEffects(sealed.attemptId, outcome.effects);
  if (!effect.safe) return parkOnDrift(request, read.run, sealed, outcome, effect.reason);
  // Leg L: publish the temp-custodied output into the authoritative CAS UNDER the
  // lock, only now that leg-K validation has passed.
  const published = await publishCustodyLocked(request.root, evidenceLocationOf(request), outcome.pendingEvidence, sealed.bounds.maximumOutputEvidenceBytes);
  if (!published) return parkOnDrift(request, read.run, sealed, outcome, "output-publication-failed");
  // A leg that FAULTED leaves the phase in an unknown state, and that is a park
  // of the RUN, not merely of the phase. Settling it instead used to append
  // `stateAfter: "running"` while the settle projector cleared the execution
  // owner, producing an ownerless `running` run carrying a `recovery-required`
  // leg — a state with NO operator exit: re-driving skips a phase that is
  // neither `pending` nor `ready`, `recovery` refuses a run recording no owner,
  // and `abandon` requires the RUN to be `recovery-required`. Routing it through
  // the same park every other recoverable failure already takes restores the
  // existing recovery model rather than adding an escape hatch.
  //
  // NOT when a cancellation owns the settlement. That path has its OWN
  // settlement immediately after this call, which records `cancelled` on the
  // run — and it exists because leaving the run `running` there let a sibling
  // phase finish behind a delivered cancel. Parking here would preempt it and
  // replace `cancelled` with `recovery-required`, discarding the operator's
  // cancel.
  //
  // THE DELIVERED OBSERVATION IS THE DISCRIMINATOR, and deliberately not the
  // advisory file. `parkedByCancellation` states the rule this must not break:
  // "anyone may write [a `.cancel`] at any time, so treating its presence as
  // proof let a cancel request carry an unrelated integrity obligation to a
  // terminal and erase it". Delivery is instead a fact about THIS executor that
  // no later file change retracts.
  //
  // KNOWN RESIDUAL, non-stranding: ANY valid cancel that is present by this
  // commit but was not DELIVERED before the leg completed — whether it was
  // published after the leg returned or landed after the final poll — is not
  // seen here, so this parks with the leg-fault code. The settlement then
  // cannot append `cancelling` (the run is no longer `running`) and will not
  // advance a park that is not cancellation-coded, so that advisory is not
  // consumed: it survives the park, and abandoning the run does not delete it
  // either — a later recovery sweep collects it as terminal residue.
  //
  // The run is NOT stranded: abandon works, which is the property this change
  // exists to restore. Reading the advisory here to narrow the window was tried
  // and rejected — it is racy in BOTH directions (a retraction between the two
  // reads skips the park and restores the ownerless-`running` strand) and it
  // makes a forgeable file authoritative over a control decision.
  if (outcome.phaseState === "recovery-required" && !cancellationObserved) {
    return parkOnDrift(request, read.run, sealed, outcome, LEG_FAULT_PARK);
  }
  await settle(request, read.run, sealed, outcome, effect.effects);
  return { status: "committed", attemptId: sealed.attemptId, phaseState: outcome.phaseState };
}

/**
 * The durable problem code one park records.
 *
 * Every park used to write the SAME generic obligation, so the record could not
 * say what had gone wrong: a revalidation drift, a bounds violation, a
 * publication failure and a cancellation that could not prove effect-freeness
 * were indistinguishable once written. Anything later deciding whether a
 * `recovery-required` run may be advanced then had nothing durable to read, and a
 * cancellation settlement could carry an unrelated integrity obligation to a
 * terminal. The cancellation park now names itself.
 */
function parkProblemCode(reason: string): PreparationRunProblemCode {
  if (reason === CANCEL_EFFECT_UNCERTAIN) return "preparation-cancellation-effect-unproven";
  if (reason === LEG_FAULT_PARK) return "preparation-leg-fault";
  return "preparation-integrity-obligation";
}

/**
 * Durably park a recoverable failure: append a `recovery-required` transition and
 * clear the execution owner (design section 12.5) so the run is left recoverable,
 * not a running-with-owner zombie that would wedge later attempts. Only OUR
 * still-fencing lease may do this; when another actor owns the run's state, leave
 * it untouched and just report the reason.
 */
async function parkOnDrift(
  request: AttemptExecutionRequestV1, run: PreparationRunV1, sealed: SealedAttemptContextV1,
  outcome: AttemptLegOutcomeV1, reason: string,
): Promise<AttemptOutcomeV1> {
  if (run.state === "running" && ownerFencesAttempt(run.executionOwner, sealed.attemptId, sealed.lease.leaseNonce)) {
    const input: AppendPreparationTransitionInput = {
      type: "recovery-required", stateAfter: "recovery-required",
      actor: { id: request.principal.id, surface: request.principal.surface }, at: request.clock.now(),
      payload: { kind: "problem", code: parkProblemCode(reason) },
    };
    await appendProjectedTransitionLocked(request.root, request.binding, preparationRunPredecessor(run), input, recoveryParkProjector(sealed, outcome));
  }
  return { status: "parked", reason };
}

/**
 * One spend dimension the signed record may carry: a figure that was METERED and
 * that the sealed ceiling ADMITS. Everything else is omitted, and omission reads
 * back as unobserved.
 *
 * Two different absences collapse here on purpose. An unmetered dimension is
 * omitted because a fabricated zero would report a billable attempt as free. An
 * over-ceiling dimension is omitted because a figure above the phase's sealed
 * authorization is not a measurement the record can vouch for — it is either a
 * runtime that overran its budget or a meter that cannot be believed, and there
 * is no way to tell which from the number alone. Clamping it to the ceiling
 * would be worse than either: it would put a figure smaller than the observed
 * spend into signed state and present it as fact, which is exactly the
 * understatement the whole `"unobserved"` sentinel exists to prevent.
 *
 * The loader cannot make this call — `parsePhaseSummary` validates the grammar
 * (bounded nonnegative integer) but never sees the plan, so the sealed ceiling is
 * only knowable here. This is the one place spend enters the run.
 */
function admissibleSpend(usage: number | "unobserved", ceiling: number): number | undefined {
  return usage === "unobserved" || usage > ceiling ? undefined : usage;
}

/**
 * Persist the attempt's admissible metered spend. Named field by field so nothing
 * else from the leg outcome can be spread into the signed summary.
 */
function durableSpend(
  bounds: SealedAttemptContextV1["bounds"], outcome: AttemptLegOutcomeV1,
): { tokenCount?: number; costMicros?: number } {
  return {
    ...optional("tokenCount", admissibleSpend(outcome.tokenCount, bounds.maximumTokensPerAttempt)),
    ...optional("costMicros", admissibleSpend(outcome.costMicros, bounds.maximumCostMicrosPerAttempt)),
  };
}

/** Clear the owner and mark the phase recovery-required on a durable park. */
function recoveryParkProjector(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): PreparationRunContentProjector {
  return (next) => {
    const { executionOwner: _cleared, ...rest } = next;
    const prior = next.phaseSummaries.find((summary) => summary.phaseInstanceId === sealed.phaseInstanceId);
    const summary: PhaseSummaryV1 = {
      phaseInstanceId: sealed.phaseInstanceId, logicalPhaseId: sealed.logicalPhaseId, state: "recovery-required",
      disposition: sealed.disposition, attemptCount: prior?.attemptCount ?? 1, currentAttemptId: sealed.attemptId,
      invocationCount: outcome.invocationCount, brokerRequestCount: outcome.brokerRequestCount, effectCount: 0,
      // CARRIED, not dropped: the leg's own problem is the only durable record
      // of what failed. A park that recorded the state but not the cause left
      // an operator unable to tell a missing tool from an integrity fault.
      ...optional("problem", outcome.problem),
      ...optional("problemDetail", outcome.problemDetail),
      ...durableSpend(sealed.bounds, outcome),
    };
    return { ...rest, phaseSummaries: upsertPhaseSummary(next.phaseSummaries, summary) };
  };
}

/** Durably append the phase-settled transition, clearing the owner and projecting facts. */
async function settle(
  request: AttemptExecutionRequestV1, run: PreparationRunV1, sealed: SealedAttemptContextV1,
  outcome: AttemptLegOutcomeV1, effects: readonly EffectSummaryV1[],
): Promise<void> {
  const input: AppendPreparationTransitionInput = {
    type: "phase-settled", stateAfter: "running", actor: { id: request.principal.id, surface: request.principal.surface },
    at: request.clock.now(), payload: { kind: "phase", phaseInstanceId: sealed.phaseInstanceId, phaseState: outcome.phaseState },
  };
  await appendProjectedTransitionLocked(request.root, request.binding, preparationRunPredecessor(run), input, settleProjector(sealed, outcome, effects));
}

/** Build the settled phase summary the commit projects onto the run. */
function settledPhaseSummary(
  sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1, prior: PhaseSummaryV1 | undefined, effectCount: number,
): PhaseSummaryV1 {
  return {
    phaseInstanceId: sealed.phaseInstanceId, logicalPhaseId: sealed.logicalPhaseId, state: outcome.phaseState,
    disposition: sealed.disposition, attemptCount: prior?.attemptCount ?? 1, currentAttemptId: sealed.attemptId,
    ...optional("outputEvidenceDigest", outcome.outputEvidenceDigest),
    invocationCount: outcome.invocationCount, brokerRequestCount: outcome.brokerRequestCount, effectCount,
    ...optional("problem", outcome.problem),
    ...optional("problemDetail", outcome.problemDetail),
    ...durableSpend(sealed.bounds, outcome),
  };
}

/** Project the settled facts, clearing the execution owner (design section 12.5). */
function settleProjector(
  sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1, effects: readonly EffectSummaryV1[],
): PreparationRunContentProjector {
  return (next) => {
    const { executionOwner: _cleared, ...rest } = next;
    const prior = next.phaseSummaries.find((summary) => summary.phaseInstanceId === sealed.phaseInstanceId);
    return {
      ...rest,
      phaseSummaries: upsertPhaseSummary(next.phaseSummaries, settledPhaseSummary(sealed, outcome, prior, effects.length)),
      evidenceRefs: [...next.evidenceRefs, ...outcome.pendingEvidence.map((item) => item.ref)],
      effectSummaries: [...next.effectSummaries, ...effects],
    };
  };
}

// --- The public entrypoint ----------------------------------------------

/**
 * Commit the outcome, then durably acknowledge and settle any operator cancel,
 * whether this executor delivered it during the leg or it arrived before the
 * commit. The PHASE is never forced to `cancelled` — a phase that raced past the
 * safe boundary keeps the state it earned — but the RUN records the cancellation
 * regardless, which is what stops the next phase from starting. A
 * provider-internal cancel with no operator advisory still leaves the run running.
 */
async function commitCancelAware(
  request: AttemptExecutionRequestV1, sealed: SealedAttemptContextV1, delivery: AttemptLegDeliveryV1,
): Promise<AttemptOutcomeV1> {
  const committed = await commitOutcome(request, sealed, delivery.outcome, delivery.cancellationObserved);
  try {
    await settleAttemptCancellationLocked(request, delivery.cancellationObserved);
  } catch {
    // The commit ALREADY happened and is durable. A failure in the settlement
    // that follows it must not be reported as a failure of the attempt, and must
    // not throw out of `executePhaseAttempt` past a result the caller has to see
    // — the attempt's own outcome is the honest answer either way.
    //
    // Skipping is safe because the settlement is idempotent and re-drivable: the
    // recovery coordinator sweeps this exact run on the next gated acquisition.
    // Note the sequence consumes TWO control-transition allowances where the
    // pre-settlement path consumed one, so a run near its control budget can
    // fail this leg while its commit stands.
  }
  return committed;
}

/**
 * Execute one lease-fenced three-leg phase attempt: seal intent under the lock,
 * run the leg with the lock released, then revalidate and commit under the lock.
 */
export async function executePhaseAttempt(input: AttemptExecutionRequestV1): Promise<AttemptOutcomeV1> {
  let request: AttemptExecutionRequestV1;
  try {
    request = captureRequest(input);
  } catch {
    return { status: "parked", reason: "request-not-capturable" };
  }
  let sealed: SealedAttemptContextV1;
  try {
    const intent = await underLock(request.root, () => recordIntent(request));
    if (intent.kind !== "sealed") return intent.outcome;
    sealed = intent.sealed;
  } catch (error) {
    if (error instanceof LockBusyError) return { status: "refused-busy" };
    throw error;
  }
  const delivery = await runAttemptLeg(request, sealed);
  try {
    return await underLock(request.root, () => commitCancelAware(request, sealed, delivery));
  } catch (error) {
    if (error instanceof LockBusyError) return { status: "parked", reason: "reacquire-busy" };
    throw error;
  } finally {
    // Always discard temporary custody: on commit its bytes are already published
    // into the authoritative CAS; on any park/timeout nothing was published.
    await discardCustody(delivery.outcome.custodyTempDir);
  }
}
