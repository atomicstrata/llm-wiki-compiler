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
 *
 * ONE BODY, {@link executePhaseAttemptWith}, over {@link AttemptExecutionSteps}
 * and a captured request without a root: the ordinary lock (a MECHANISM whose
 * `LockBusyError` the body turns into `refused-busy` or `reacquire-busy`), the
 * run and manifest reads, the projected append, custody publication, the
 * cancellation poll and the cancellation settlement. Every decision is in the
 * body or in the pure policy of `execute-policy.ts`. {@link executePhaseAttempt}
 * keeps its signature, captures the request exactly as before (a non-string
 * root still parks) and passes the local steps for the captured request;
 * {@link attemptExecutionStepsOver} composes them from each store's own body.
 */

import { withAttemptMutationLock as underLock } from "../../operation-bundles/with-mutation-lock.js";
import { LockBusyError } from "../../utils/lock.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import { captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { deriveAttemptId, type AttemptId, type PhaseInstanceId } from "../ids.js";
import {
  preparationCancellationRequested, preparationCancellationRequestedFrom,
  type PreparationCancelLeaves, type PreparationCancellationProbe,
} from "../cancellation.js";
import {
  readPreparationManifest, readPreparationManifestFrom, type PreparationManifestLeafReads, type PreparationManifestRead,
} from "../manifest-store.js";
import { preparationRunPredecessor } from "../run-integrity.js";
import {
  appendPreparationTransitionWith, appendProjectedTransitionLocked, readPreparationRun, readPreparationRunFrom,
  type PreparationRunLeafReads, type PreparationRunRead, type PreparationRunWriteSteps,
} from "../run-store.js";
import { settleAttemptCancellationLocked, settleAttemptCancellationWith, type CancelSettlementSources } from "./cancel-settlement.js";
import { runAttemptLegWith, type AttemptLegDeliveryV1 } from "./cancel-delivery.js";
import type { PreparationManifestV1 } from "../manifest-parse.js";
import type { NormalizedPhaseV1, PhaseExecutorV1 } from "../plan-types.js";
import type {
  AppendPreparationTransitionInput, EffectSummaryV1,
  PreparationRunBinding, PreparationPrincipalV1, PreparationRunPredecessor, PreparationRunV1,
} from "../run-types.js";
import type { PreparationRunContentProjector } from "../run-store.js";
import { authoritySnapshotDigest, computeSealedAuthority, sealAttemptContext, attemptIntentProjector } from "./start.js";
import { mintAttemptLease, ownerFencesAttempt, ownerProcessIsLive } from "./lease.js";
import { discardCustody, publishCustodyLocked, publishCustodyWith } from "./custody.js";
import type { PreparationEvidenceLocation, PreparationEvidenceWriteSteps } from "../evidence-store.js";
import { ATTEMPT_STARTABLE_RUN_STATES } from "./types.js";
import type {
  AttemptAuthorityResolverV1, AttemptClockV1, AttemptExecutionRequestV1,
  AttemptLegOutcomeV1, AttemptLegRunnerV1, AttemptOutcomeV1, PendingEvidenceV1, SealAuthorityExtrasV1, SealedAttemptContextV1,
} from "./types.js";
import {
  LEG_FAULT_PARK, boundsViolation, cancelEffectUncertain, observedDrift, optional, parkProblemCode,
  recordEffects, recoveryParkProjector, settleProjector,
} from "./execute-policy.js";

export { boundsViolation } from "./execute-policy.js";
/** Require a non-empty string, translating a hostile value into refusal. */
function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("attempt request field is not a string");
  return value;
}

/** What one attempt runs on: the captured request without its project root. */
export type AttemptBodyRequestV1 = Omit<AttemptExecutionRequestV1, "root">;

/** What one attempt asks for, in order. No member takes a project root. */
export interface AttemptExecutionSteps {
  /** MECHANISM: run `work` under the ordinary project lock, releasing it after; THROWS `LockBusyError` when busy. */
  lock<T>(work: () => Promise<T>): Promise<T>;
  /** The run at `binding`, authenticated. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  /** The preparation's immutable manifest. */
  readManifest(workspaceId: string, preparationId: PreparationRunBinding["preparationId"]): Promise<PreparationManifestRead>;
  /** The projected append fenced to `expected`. */
  appendProjected(
    binding: PreparationRunBinding, expected: PreparationRunPredecessor,
    input: AppendPreparationTransitionInput, project: PreparationRunContentProjector,
  ): Promise<PreparationRunV1>;
  /** Publish the temp-custodied output into the evidence CAS; false when any object fails its check. */
  publishCustody(location: PreparationEvidenceLocation, pending: readonly PendingEvidenceV1[], cap: number): Promise<boolean>;
  /** The lock-free cancellation poll the leg runs under. */
  readonly cancellationRequested: PreparationCancellationProbe;
  /** Durably acknowledge and settle any operator cancel for this attempt's run. */
  settleCancellation(delivered: boolean): Promise<void>;
}

/** LOCAL DISK. The incumbent lock, readers and writers for the captured request's root, each called when asked. */
function diskAttemptExecutionSteps(request: AttemptExecutionRequestV1): AttemptExecutionSteps {
  const root = request.root;
  return {
    lock: (work) => underLock(root, work),
    readRun: (binding) => readPreparationRun(root, binding),
    readManifest: (workspaceId, preparationId) => readPreparationManifest(root, workspaceId, preparationId),
    appendProjected: (binding, expected, input, project) => appendProjectedTransitionLocked(root, binding, expected, input, project),
    publishCustody: (location, pending, cap) => publishCustodyLocked(root, location, pending, cap),
    cancellationRequested: (workspaceId, runId) => preparationCancellationRequested(root, workspaceId, runId),
    settleCancellation: (delivered) => settleAttemptCancellationLocked(request, delivered),
  };
}

/** The same steps over each store's own body, under the caller's `lock`, settling for `request`. Building it does no I/O. */
export function attemptExecutionStepsOver(sources: {
  runs: PreparationRunLeafReads; manifests: PreparationManifestLeafReads; writes: PreparationRunWriteSteps;
  evidence: PreparationEvidenceWriteSteps; advisories: PreparationCancelLeaves; settlement: CancelSettlementSources;
}, lock: AttemptExecutionSteps["lock"], request: Pick<AttemptExecutionRequestV1, "binding" | "principal" | "clock">): AttemptExecutionSteps {
  return {
    lock,
    readRun: (binding) => readPreparationRunFrom(sources.runs, binding),
    readManifest: (workspaceId, preparationId) => readPreparationManifestFrom(sources.manifests, workspaceId, preparationId),
    appendProjected: (binding, expected, input, project) => appendPreparationTransitionWith(sources.writes, binding, expected, input, project),
    publishCustody: (location, pending, cap) => publishCustodyWith(sources.evidence, location, pending, cap),
    cancellationRequested: (workspaceId, runId) => preparationCancellationRequestedFrom(sources.advisories, workspaceId, runId),
    settleCancellation: (delivered) => settleAttemptCancellationWith(sources.settlement, request, delivered),
  };
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
  return Object.freeze({ root: requireString(top.root), ...captureBody(top) });
}

/** The same capture of everything but the root, from an own-data snapshot of the caller's request. */
function captureBody(top: Readonly<Record<string, unknown>>): AttemptBodyRequestV1 {
  const binding = captureOwnDataRecord(top.binding);
  const principal = captureOwnDataRecord(top.principal);
  const resolver = top.authorityResolver as AttemptAuthorityResolverV1;
  const clock = top.clock as AttemptClockV1;
  return Object.freeze({
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
function evidenceLocationOf(request: AttemptBodyRequestV1): PreparationEvidenceLocation {
  return { workspaceId: request.binding.workspaceId, preparationId: request.binding.preparationId };
}

/** One work phase proven to carry an executor. */
type ExecutablePhase = NormalizedPhaseV1 & { executor: PhaseExecutorV1 };

/** A not-ok run read; its finer typed code is surfaced so a transient and an
 * integrity-invalid run never collapse to the same opaque park reason. */
type RunReadNotOk = Exclude<Awaited<ReturnType<typeof readPreparationRun>>, { status: "ok" }>;

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
async function resolveAuthorityExtras(request: AttemptBodyRequestV1, phase: ExecutablePhase): Promise<ExtrasResolution> {
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
async function prepareIntent(steps: AttemptExecutionSteps, request: AttemptBodyRequestV1): Promise<PreparedIntent> {
  const read = await steps.readRun(request.binding);
  if (read.status !== "ok") return { kind: "done", outcome: { status: "parked", reason: runReason(read) } };
  // Through the exported set, so the sweep that derives "which states leave a
  // cancellation advisory with no consumer" reads the same enumeration this
  // precondition enforces rather than a copy of it.
  if (!ATTEMPT_STARTABLE_RUN_STATES.has(read.run.state)) {
    return { kind: "done", outcome: { status: "parked", reason: `run-not-startable-${read.run.state}` } };
  }
  const manifest = await readManifest(steps, request);
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
async function recordIntent(steps: AttemptExecutionSteps, request: AttemptBodyRequestV1): Promise<IntentResult> {
  const prepared = await prepareIntent(steps, request);
  if (prepared.kind === "done") return done(prepared.outcome);
  const resolved = await resolveAuthorityExtras(request, prepared.phase);
  if (resolved.kind !== "ok") return done({ status: "parked", reason: resolved.reason });
  const attemptId = deriveAttemptId(request.phaseInstanceId, request.attemptIndex);
  const sealed = seal(request, prepared.manifest, prepared.phase, attemptId, resolved.extras, prepared.run.stateVersion);
  await writeIntent(steps, request, prepared.run, sealed);
  return { kind: "sealed", sealed };
}

/** Read the immutable manifest bound to the run, or null when unavailable. */
async function readManifest(steps: AttemptExecutionSteps, request: AttemptBodyRequestV1): Promise<PreparationManifestV1 | null> {
  const read = await steps.readManifest(request.binding.workspaceId, request.binding.preparationId);
  return read.status === "ok" ? read.manifest : null;
}

/**
 * Refuse a second attempt when one is already in flight (a live execution owner)
 * and park when a prior owner is dead or the phase already reached a
 * non-restartable state; only a provably absent or failed/cancelled phase starts.
 */
function startGuard(request: AttemptBodyRequestV1, run: PreparationRunV1): AttemptOutcomeV1 | null {
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
  request: AttemptBodyRequestV1, manifest: PreparationManifestV1, phase: ExecutablePhase,
  attemptId: AttemptId, extras: SealAuthorityExtrasV1, stateVersion: number,
): SealedAttemptContextV1 {
  return sealAttemptContext({
    manifest, executor: phase.executor, bounds: phase.bounds, extras, attemptId,
    phaseInstanceId: request.phaseInstanceId, logicalPhaseId: phase.logicalPhaseId,
    disposition: phase.disposition, lease: mintAttemptLease(request.clock.now()), stateVersionAtSeal: stateVersion,
  });
}

/** Durably append the phase-started transition, execution owner, and phase summary. */
async function writeIntent(steps: AttemptExecutionSteps, request: AttemptBodyRequestV1, run: PreparationRunV1, sealed: SealedAttemptContextV1): Promise<void> {
  const priorPhase = run.phaseSummaries.find((summary) => summary.phaseInstanceId === request.phaseInstanceId);
  const attemptCount = (priorPhase?.attemptCount ?? 0) + 1;
  const input: AppendPreparationTransitionInput = {
    type: "phase-started", stateAfter: "running", actor: { id: request.principal.id, surface: request.principal.surface },
    at: request.clock.now(), payload: { kind: "phase", phaseInstanceId: sealed.phaseInstanceId, phaseState: "running" },
  };
  await steps.appendProjected(request.binding, preparationRunPredecessor(run), input, attemptIntentProjector(sealed, attemptCount));
}

function done(outcome: AttemptOutcomeV1): IntentResult { return { kind: "done", outcome }; }

// --- Leg F–H: run the leg with the lock RELEASED ------------------------
// Owned by {@link file://./cancel-delivery.ts}: the pre-launch boundary check,
// the executor-owned cancellation signal and its advisory poll, the leg call,
// and the bounded post-delivery deadline. It touches no lock and no durable
// state, which is exactly why it lives outside this orchestrator.

// --- Leg I–L: revalidate and commit under the project lock --------------

/**
 * Re-verify lease and run state, then RE-RESOLVE the authority from current state
 * and compare its snapshot to the sealed one. Re-resolution (not a recompute over
 * the sealed values) is what makes the gate detect a genuine pin/grant/effect/
 * broker drift on a receiptless phase (design section 15.3).
 */
async function revalidate(steps: AttemptExecutionSteps, request: AttemptBodyRequestV1, sealed: SealedAttemptContextV1, run: PreparationRunV1): Promise<string | null> {
  if (!ownerFencesAttempt(run.executionOwner, sealed.attemptId, sealed.lease.leaseNonce)) return "lease-drift";
  if (run.state !== "running") return `run-not-running-${run.state}`;
  const manifest = await readManifest(steps, request);
  if (manifest === null) return "manifest-unavailable";
  const lookup = findExecutablePhase(manifest, sealed.logicalPhaseId);
  if (lookup.kind !== "ok") return "phase-drift";
  const resolved = await resolveAuthorityExtras(request, lookup.phase);
  if (resolved.kind !== "ok") return resolved.reason;
  const current = authoritySnapshotDigest(computeSealedAuthority(manifest, sealed.executor, resolved.extras));
  return current === sealed.authoritySnapshotDigest ? null : "authority-drift";
}

/** Commit the honest outcome, or durably park when a check fails closed. */
/**
 * The park reason that blocks settlement, or null when the outcome may settle.
 * ORDER IS THE CONTRACT: authority revalidation first (a drifted authority
 * invalidates everything measured under it), then observed drift, then the
 * bounds violation, then an unprovable cancellation.
 */
async function preSettlementBlocker(
  steps: AttemptExecutionSteps, request: AttemptBodyRequestV1, sealed: SealedAttemptContextV1,
  run: PreparationRunV1, outcome: AttemptLegOutcomeV1,
): Promise<string | null> {
  return (await revalidate(steps, request, sealed, run)) ?? observedDrift(sealed, outcome)
    ?? boundsViolation(sealed, outcome) ?? cancelEffectUncertain(sealed, outcome);
}

async function commitOutcome(
  steps: AttemptExecutionSteps, request: AttemptBodyRequestV1, sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1,
  cancellationObserved: boolean,
): Promise<AttemptOutcomeV1> {
  const read = await steps.readRun(request.binding);
  if (read.status !== "ok") return { status: "parked", reason: runReason(read) };
  const reason = await preSettlementBlocker(steps, request, sealed, read.run, outcome);
  if (reason !== null) return parkOnDrift(steps, request, read.run, sealed, outcome, reason);
  const effect = recordEffects(sealed.attemptId, outcome.effects);
  if (!effect.safe) return parkOnDrift(steps, request, read.run, sealed, outcome, effect.reason);
  // Leg L: publish the temp-custodied output into the authoritative CAS UNDER the
  // lock, only now that leg-K validation has passed.
  const published = await steps.publishCustody(evidenceLocationOf(request), outcome.pendingEvidence, sealed.bounds.maximumOutputEvidenceBytes);
  if (!published) return parkOnDrift(steps, request, read.run, sealed, outcome, "output-publication-failed");
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
    return parkOnDrift(steps, request, read.run, sealed, outcome, LEG_FAULT_PARK);
  }
  await settle(steps, request, read.run, sealed, outcome, effect.effects);
  return { status: "committed", attemptId: sealed.attemptId, phaseState: outcome.phaseState };
}

/**
 * Durably park a recoverable failure: append a `recovery-required` transition and
 * clear the execution owner (design section 12.5) so the run is left recoverable,
 * not a running-with-owner zombie that would wedge later attempts. Only OUR
 * still-fencing lease may do this; when another actor owns the run's state, leave
 * it untouched and just report the reason.
 */
async function parkOnDrift(
  steps: AttemptExecutionSteps, request: AttemptBodyRequestV1, run: PreparationRunV1, sealed: SealedAttemptContextV1,
  outcome: AttemptLegOutcomeV1, reason: string,
): Promise<AttemptOutcomeV1> {
  if (run.state === "running" && ownerFencesAttempt(run.executionOwner, sealed.attemptId, sealed.lease.leaseNonce)) {
    const input: AppendPreparationTransitionInput = {
      type: "recovery-required", stateAfter: "recovery-required",
      actor: { id: request.principal.id, surface: request.principal.surface }, at: request.clock.now(),
      payload: { kind: "problem", code: parkProblemCode(reason) },
    };
    await steps.appendProjected(request.binding, preparationRunPredecessor(run), input, recoveryParkProjector(sealed, outcome));
  }
  return { status: "parked", reason };
}

/** Durably append the phase-settled transition, clearing the owner and projecting facts. */
async function settle(
  steps: AttemptExecutionSteps, request: AttemptBodyRequestV1, run: PreparationRunV1, sealed: SealedAttemptContextV1,
  outcome: AttemptLegOutcomeV1, effects: readonly EffectSummaryV1[],
): Promise<void> {
  const input: AppendPreparationTransitionInput = {
    type: "phase-settled", stateAfter: "running", actor: { id: request.principal.id, surface: request.principal.surface },
    at: request.clock.now(), payload: { kind: "phase", phaseInstanceId: sealed.phaseInstanceId, phaseState: outcome.phaseState },
  };
  await steps.appendProjected(request.binding, preparationRunPredecessor(run), input, settleProjector(sealed, outcome, effects));
}

/**
 * Commit the outcome, then durably acknowledge and settle any operator cancel,
 * whether this executor delivered it during the leg or it arrived before the
 * commit. The PHASE is never forced to `cancelled` — a phase that raced past the
 * safe boundary keeps the state it earned — but the RUN records the cancellation
 * regardless, which is what stops the next phase from starting. A
 * provider-internal cancel with no operator advisory still leaves the run running.
 */
async function commitCancelAware(
  steps: AttemptExecutionSteps, request: AttemptBodyRequestV1, sealed: SealedAttemptContextV1, delivery: AttemptLegDeliveryV1,
): Promise<AttemptOutcomeV1> {
  const committed = await commitOutcome(steps, request, sealed, delivery.outcome, delivery.cancellationObserved);
  try {
    await steps.settleCancellation(delivery.cancellationObserved);
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
  return executePhaseAttemptWith(diskAttemptExecutionSteps(request), request);
}

/**
 * {@link executePhaseAttempt} over {@link AttemptExecutionSteps}: THE ONE BODY.
 * The request is captured again here, before the first await, so a direct caller
 * gets the same frozen snapshot the facade takes.
 */
export async function executePhaseAttemptWith(steps: AttemptExecutionSteps, input: AttemptBodyRequestV1): Promise<AttemptOutcomeV1> {
  let request: AttemptBodyRequestV1;
  try {
    request = captureBody(captureOwnDataRecord(input));
  } catch {
    return { status: "parked", reason: "request-not-capturable" };
  }
  let sealed: SealedAttemptContextV1;
  try {
    const intent = await steps.lock(() => recordIntent(steps, request));
    if (intent.kind !== "sealed") return intent.outcome;
    sealed = intent.sealed;
  } catch (error) {
    if (error instanceof LockBusyError) return { status: "refused-busy" };
    throw error;
  }
  const delivery = await runAttemptLegWith(steps.cancellationRequested, request, sealed);
  try {
    return await steps.lock(() => commitCancelAware(steps, request, sealed, delivery));
  } catch (error) {
    if (error instanceof LockBusyError) return { status: "parked", reason: "reacquire-busy" };
    throw error;
  } finally {
    // Always discard temporary custody: on commit its bytes are already published
    // into the authoritative CAS; on any park/timeout nothing was published.
    await discardCustody(delivery.outcome.custodyTempDir);
  }
}
