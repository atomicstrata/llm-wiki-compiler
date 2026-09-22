/**
 * @file src/preparations/runner.ts
 * @description The host orchestration coordinator (runner design v3 §§4, 9,
 * 10): drives one staged preparation from its durable plan through attempt
 * execution, contract-bound materialization, finalization, and the existing
 * handoff seam. Deliberately OUTSIDE the frozen fourteen-operation service —
 * a driver over the substrate, not a member of it.
 *
 * THE ENTRY SIGNATURE IS THE CONSTRAINT. `RunPreparationInputV1` carries
 * capabilities and identity only — no obligation material. A caller cannot
 * supply targets, proposals, authorities, completeness, or payload content;
 * the materializer derives them from durable state, and after finalization the
 * runner RECONSTRUCTS the obligation set from the persisted manifest, never
 * from memory. Fresh and restarted runs therefore share one assembly path, so
 * restart-equivalence is structural: the materializer is consulted only while
 * the run is still `running`, and its absence after `handoff-ready` cannot
 * strand anything.
 *
 * `refused-busy` is a scheduling outcome, retried under a small bound and
 * NEVER counted toward a phase's retry exhaustion — lock contention is a
 * property of how many phases happen to be running, and letting it manufacture
 * a retry failure is the load-dependent defect class this program exists to
 * remove. A gate suspension is likewise a resumable state, not a park.
 */

import { PackMaterializationError } from "../operations-packs/problems.js";
import { createHash } from "node:crypto";
import type { OperationAdapterMap } from "../operation-bundles/adapter-registry.js";
import type { OperationPrincipal } from "../operation-bundles/principal.js";
import type { Sha256Digest } from "../capability-providers/types.js";
import { executePhaseAttempt } from "./attempts/execute.js";
import type {
  AttemptAuthorityResolverV1, AttemptClockV1, AttemptLegRunnerV1,
} from "./attempts/types.js";
import { finalizePreparationForHandoff } from "./finalization.js";
import { handoffPreparation, HandoffError } from "./handoff.js";
import {
  MaterializationCaptureError, NoObligationError, captureMaterializationResult, classifyMaterializationManifests,
  type MaterializationResultV1,
} from "./materialization.js";
import { handoffRequest, readManifestBack, readPayloadsBack } from "./runner-reconstruct.js";
import { readPreparationEvidenceBytes } from "./evidence-store.js";
import { readPreparationManifest } from "./manifest-store.js";
import { derivePhaseInstanceId, singleExpansionIdentity } from "./ids.js";
import { driveMapPhase, driveRepeatPhase } from "./fan-out-driver.js";
import { blockAtGate, resumeFromGate, hasProceedDecision, type GatePhaseV1 } from "./gate-driver.js";
import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import { phaseIsReady, readyPhaseSchedule } from "./readiness.js";
import type { PhaseInstanceState } from "./run-types.js";
import type { NormalizedPhaseV1 } from "./plan-types.js";
import type { PreparationPolicyContractV1 } from "./selection.js";
import { appendPreparationTransitionLocked, readPreparationRun } from "./run-store.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import type {
  PreparationPrincipalV1, PreparationRunBinding, PreparationRunV1,
} from "./run-types.js";

/** The contract-bound materializer a pack supplies (design §5). */
export interface PreparationMaterializerV1 {
  /** Must equal the plan-pinned handler contract digest, or the runner refuses. */
  readonly handlerContractDigest: Sha256Digest;
  /** One total call: every obligation component in one data-only candidate. */
  materialize(input: { run: PreparationRunV1; evidence: ReadonlyMap<string, Buffer> }): {
    readonly result: unknown;
    readonly payloads: ReadonlyMap<string, Buffer>;
  };
}

/** Capabilities and identity ONLY — no obligation material may appear here. */
export interface RunPreparationInputV1 {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  /** Required only to DRIVE a running plan; restart never consults it. */
  readonly materializer?: PreparationMaterializerV1;
  /**
   * Per-phase leg supplier (Chunk 3 unit A). The runner drives phases with
   * heterogeneous executor kinds — a provider-capability phase and a
   * host-handler phase cannot share one leg runner, because each throws on the
   * wrong kind. The host owns the executor-kind→leg mapping and resolves it per
   * phase; the runner never constructs a provider request or host result itself.
   */
  readonly legFor: (logicalPhaseId: string) => AttemptLegRunnerV1;
  /**
   * Pack-supplied item decoder for fan-out (Chunk 3 unit B). A `map` phase
   * fans over the items in its source phase's output evidence, but the item
   * ENCODING is pack data the runner must not know — decoding is a capability,
   * like the materializer. Absent, a `map` phase is refused rather than
   * silently driven as a single instance. Given the verified source-evidence
   * bytes, it returns the decoded items in source order.
   */
  readonly decodeExpansionItems?: (logicalPhaseId: string, evidence: Buffer) => readonly unknown[];
  readonly authorityResolver: AttemptAuthorityResolverV1;
  readonly adapters: OperationAdapterMap;
  readonly policyContract: PreparationPolicyContractV1;
  readonly principal: PreparationPrincipalV1;
  readonly operationPrincipal: OperationPrincipal;
  readonly handlerContractDigest: Sha256Digest;
  readonly clock: AttemptClockV1;
}

/**
 * Deterministic crash seams at the runner's durable boundaries — INTERNAL / TEST
 * ONLY, and deliberately NOT a field of {@link RunPreparationInputV1} nor a
 * parameter of the public {@link runPreparation}. A test reaches them through
 * {@link runPreparationWithFaults}, which is NOT re-exported from the package
 * barrel, so the shipped surface exposes no crash-injection API (the SAME
 * discipline as handoff.ts's request-local `faultsForTest`). `afterFinalized`
 * fires once finalization has committed the run to `handoff-ready` but the
 * hand-off has not started; `afterStage` is threaded into the hand-off's own
 * after-stage seam so a partial hand-off (`handoff-started`) is producible through
 * the real runner path.
 */
export interface RunnerFaultsForTestV1 {
  readonly afterFinalized?: () => Promise<void>;
  readonly afterStage?: () => Promise<void>;
}

/** The closed runner outcome (design §7). */
export type RunPreparationResultV1 =
  | { readonly status: "handed-off" | "resumed"; readonly runId: string; readonly bundleManifestDigest: string }
  | { readonly status: "suspended-at-gate"; readonly runId: string }
  | { readonly status: "nothing-to-propose"; readonly runId: string; readonly reason: string }
  | { readonly status: "parked" | "blocked" | "refused"; readonly runId: string; readonly reason: string }
  | { readonly status: "cancelled" | "cancelled-with-effects"; readonly runId: string }
  | { readonly status: "refused-busy"; readonly runId: string };

/** Bounded lock-contention retries; NEVER counted toward retry exhaustion. */
const MAX_BUSY_RETRIES = 1;

/**
 * Drive one staged run to handoff, resuming any already-finalized state.
 *
 * EVERY identity, binding, and callable is CAPTURED SYNCHRONOUSLY before the
 * first await — a caller retaining the input object cannot swap a method or
 * mutate a principal after invocation and have the substitution stamped into
 * durable state. Durable state is classified BEFORE the materializer is
 * required, so restart genuinely never needs one.
 */
export function runPreparation(callerInput: RunPreparationInputV1): Promise<RunPreparationResultV1> {
  return runPreparationCore(callerInput, undefined);
}

/**
 * INTERNAL / TEST-ONLY sibling of {@link runPreparation}: drive with deterministic
 * crash seams at the durable boundaries. NOT re-exported from the package barrel,
 * so the shipped runtime surface carries no crash-injection entry.
 */
export function runPreparationWithFaults(
  callerInput: RunPreparationInputV1, faults: RunnerFaultsForTestV1,
): Promise<RunPreparationResultV1> {
  return runPreparationCore(callerInput, faults);
}

async function runPreparationCore(
  callerInput: RunPreparationInputV1, faults: RunnerFaultsForTestV1 | undefined,
): Promise<RunPreparationResultV1> {
  const input = captureRunnerInput(callerInput);
  // Classify the run state FIRST: a terminal run (cancelled, cancelled-with-effects,
  // failed, …) reports its outcome without ever needing materialization limits, so
  // surfacing `cancelled-with-effects` (unit F) must not depend on the plan's
  // materialization triple. Limits are required only to DRIVE or RECONSTRUCT.
  const state = await runState(input);
  if (typeof state !== "string") return state;
  const limits = await declaredMaterializationLimits(input);
  if (limits === null) {
    return { status: "refused", runId: input.binding.runId, reason: "plan does not declare the materialization limits" };
  }
  if (state === "drive") {
    if (input.materializer === undefined) {
      return { status: "refused", runId: input.binding.runId, reason: "a running plan requires a materializer" };
    }
    if (input.materializer.handlerContractDigest !== input.handlerContractDigest) {
      return { status: "refused", runId: input.binding.runId, reason: "materializer contract does not match the plan pin" };
    }
    const driven = await drivePhases(input);
    if (driven !== null) return driven;
    const finalized = await materializeAndFinalize(input, input.materializer, limits);
    if (finalized !== null) return finalized;
    // TEST-ONLY crash seam: finalization has committed the run to `handoff-ready`,
    // the hand-off has NOT started. Undefined (a no-op) in production.
    await faults?.afterFinalized?.();
  }
  return reconstructAndHandoff(input, limits, faults);
}

/**
 * Capture the caller's input synchronously: principals deep-copied, the
 * binding copied field-by-field, and every capability pinned to the exact
 * function reference present at invocation (`bind` freezes the receiver, so a
 * later method swap on the caller's retained object changes nothing here).
 */
function captureRunnerInput(input: RunPreparationInputV1): RunPreparationInputV1 {
  const materializer = input.materializer === undefined ? undefined : {
    handlerContractDigest: input.materializer.handlerContractDigest,
    materialize: input.materializer.materialize.bind(input.materializer),
  };
  return {
    root: input.root,
    binding: { ...input.binding },
    ...(materializer === undefined ? {} : { materializer }),
    legFor: input.legFor.bind(input),
    ...(input.decodeExpansionItems === undefined ? {} : { decodeExpansionItems: input.decodeExpansionItems }),
    // The resolver is an OBJECT whose method the attempt layer calls after our
    // earlier awaits — the same seam as the materializer, and the sibling the
    // fourth review round caught retained un-bound. Data inputs (the adapter
    // map's entries, the policy contract and its vocabularies) are pinned by
    // copy for the same reason principals are.
    authorityResolver: { resolve: input.authorityResolver.resolve.bind(input.authorityResolver) },
    adapters: new Map(input.adapters),
    policyContract: {
      ...input.policyContract,
      exclusionReasonCodes: [...input.policyContract.exclusionReasonCodes],
      reconciliationReasonCodes: [...input.policyContract.reconciliationReasonCodes],
      proposalKinds: [...input.policyContract.proposalKinds],
    },
    principal: { ...input.principal },
    operationPrincipal: {
      id: input.operationPrincipal.id, surface: input.operationPrincipal.surface,
      grants: [...input.operationPrincipal.grants],
    },
    handlerContractDigest: input.handlerContractDigest,
    clock: { now: input.clock.now.bind(input.clock) },
  };
}

/**
 * Read the run and classify which path this invocation takes: `drive` runs
 * phases then finalizes; `reconstruct` skips straight to the persisted-manifest
 * handoff (the restart path); everything else is a terminal mapping. A gate is
 * a resumable suspension, never a park (design §7).
 */
async function runState(
  input: RunPreparationInputV1,
): Promise<"drive" | "reconstruct" | RunPreparationResultV1> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") {
    return { status: "refused", runId: input.binding.runId, reason: `run unreadable: ${read.status}` };
  }
  const state = read.run.state;
  // A freshly staged run is `planned`; the attempt's own sealed intent
  // performs planned → running, so both states are driveable here.
  const paths: Record<string, "drive" | "reconstruct"> = {
    // `awaiting-gate` is driveable: drivePhases re-enters and the gate phase
    // either resumes (proceed decision recorded) or re-suspends. It is a
    // resumable suspension, not a park (runner design v3 §7).
    planned: "drive", running: "drive", "awaiting-gate": "drive",
    "handoff-ready": "reconstruct", "handoff-started": "reconstruct",
  };
  const path = paths[state];
  if (path !== undefined) return path;
  if (state === "handed-off" && read.run.handoff !== undefined) {
    // Idempotent re-invocation of a terminal run reports the RECORDED outcome
    // from the durable binding — never a refusal, never a re-handoff.
    return { status: "handed-off", runId: input.binding.runId,
      bundleManifestDigest: read.run.handoff.bundleManifestDigest };
  }
  return terminalMapping(state, input.binding.runId);
}

/** Map every non-driveable, non-reconstructable state to its closed outcome. */
function terminalMapping(state: string, runId: string): RunPreparationResultV1 {
  // `awaiting-gate` is no longer terminal here — runState routes it to `drive`
  // so driveGatePhase can resume or re-suspend it (unit C). `cancelled-with-effects`
  // is surfaced as its OWN result (Chunk 3 unit F): the durable distinction —
  // a cancellation that left an applied external effect behind — is more precise
  // than collapsing it into a reason-free `cancelled`, and the caller must be able
  // to react to residual effects without parsing a reason string.
  if (state === "cancelled-with-effects") return { status: "cancelled-with-effects", runId };
  if (state === "cancelling" || state === "cancelled") return { status: "cancelled", runId };
  return { status: "refused", runId, reason: `run state is ${state}` };
}

/** Drive every unsettled plan phase through one committed attempt; null = done. */
async function drivePhases(input: RunPreparationInputV1): Promise<RunPreparationResultV1 | null> {
  const manifest = await readPreparationManifest(input.root, input.binding.workspaceId, input.binding.preparationId);
  if (manifest.status !== "ok") {
    return { status: "refused", runId: input.binding.runId, reason: "preparation manifest unreadable" };
  }
  const phases = manifest.manifest.plan.phases;
  const planDigest = parseSha256Digest(canonicalDigest(manifest.manifest.plan));
  for (const phase of readyPhaseSchedule(phases)) {
    const blocked = await guardReadiness(input, phases, phase);
    if (blocked !== null) return blocked;
    const outcome = await drivePhase(input, phase, planDigest);
    if (outcome !== null) return outcome;
  }
  return null;
}

/** The phase states that settle a run leg: nothing further will be driven for it. */
const SETTLED_PHASE_STATES: ReadonlySet<PhaseInstanceState> =
  new Set(["succeeded", "succeeded-with-warnings", "skipped-optional", "failed", "cancelled", "superseded"]);
const SUCCEEDED_PHASE_STATES: ReadonlySet<PhaseInstanceState> = new Set(["succeeded", "succeeded-with-warnings"]);

/**
 * Refuse to drive a phase whose durable predecessors are not satisfied — a REQUIRED
 * predecessor must have SUCCEEDED, an OPTIONAL one need only have SETTLED (it may
 * have failed or been skipped). Readiness is derived from the CURRENT phase
 * summaries, not graph position: without this a phase whose required predecessor
 * committed `failed` would still run, executing later handlers or effects after
 * the failure.
 */
async function guardReadiness(
  input: RunPreparationInputV1, phases: readonly NormalizedPhaseV1[], phase: NormalizedPhaseV1,
): Promise<RunPreparationResultV1 | null> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") return { status: "refused", runId: input.binding.runId, reason: "run unreadable" };
  if (phaseIsReady(phase, satisfiedPredecessors(read.run, phases))) return null;
  return { status: "blocked", runId: input.binding.runId, reason: `phase ${phase.logicalPhaseId} has an unsatisfied predecessor` };
}

/** Logical phases whose durable outcome satisfies a dependent (required⇒succeeded, optional⇒settled). */
function satisfiedPredecessors(run: PreparationRunV1, phases: readonly NormalizedPhaseV1[]): ReadonlySet<string> {
  const optional = new Set(phases.filter((phase) => phase.disposition === "optional").map((phase) => phase.logicalPhaseId));
  const total = new Map<string, number>();
  const satisfied = new Map<string, number>();
  for (const summary of run.phaseSummaries) {
    const admits = optional.has(summary.logicalPhaseId) ? SETTLED_PHASE_STATES : SUCCEEDED_PHASE_STATES;
    total.set(summary.logicalPhaseId, (total.get(summary.logicalPhaseId) ?? 0) + 1);
    if (admits.has(summary.state)) satisfied.set(summary.logicalPhaseId, (satisfied.get(summary.logicalPhaseId) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [id, count] of total) if (satisfied.get(id) === count) result.add(id);
  return result;
}

/** Dispatch a phase by its expansion: one instance, or a fanned-out set. */
async function drivePhase(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1, planDigest: Sha256Digest,
): Promise<RunPreparationResultV1 | null> {
  if (phase.role === "gate") return driveGatePhase(input, phase, planDigest);
  const driveInstance = (logicalPhaseId: string, expansionIdentity: string): Promise<RunPreparationResultV1 | null> =>
    driveOnePhase(input, logicalPhaseId, expansionIdentity);
  if (phase.expansion.kind === "map") return driveMapPhase(input, phase, phase.expansion, driveInstance);
  if (phase.expansion.kind === "bounded-repeat") return driveRepeatPhase(input, phase, phase.expansion, driveInstance);
  return driveOnePhase(input, phase.logicalPhaseId, singleExpansionIdentity());
}

/**
 * Drive a `gate` phase (Chunk 3 unit C). A gate is not executed — the runner
 * moves the run state. With a proceed decision recorded it resumes
 * `awaiting-gate → running` (or skips if already past); without one it blocks
 * `running → awaiting-gate` and returns `suspended-at-gate`, a resumable
 * outcome the caller drives again after the operator decides.
 */
async function driveGatePhase(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1, planDigest: Sha256Digest,
): Promise<RunPreparationResultV1 | null> {
  const gate: GatePhaseV1 = {
    logicalPhaseId: phase.logicalPhaseId, gateId: phase.gate?.gateId ?? phase.logicalPhaseId,
    disposition: phase.disposition, currentPlanDigest: planDigest,
    phaseInstanceId: derivePhaseInstanceId({
      manifestDigest: input.binding.manifestDigest, logicalPhaseId: phase.logicalPhaseId,
      expansionIdentity: singleExpansionIdentity(),
    }),
  };
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") return { status: "refused", runId: input.binding.runId, reason: "run unreadable" };
  return hasProceedDecision(read.run, gate)
    ? resumeDecidedGate(input, gate, read.run.state)
    : blockUndecidedGate(input, gate, read.run.state);
}

/** A decided gate: resume `awaiting-gate → running`, or pass through if already resumed. */
async function resumeDecidedGate(
  input: RunPreparationInputV1, gate: GatePhaseV1, state: PreparationRunV1["state"],
): Promise<RunPreparationResultV1 | null> {
  if (state !== "awaiting-gate") return null; // decided and already resumed — gate passed
  const moved = await resumeFromGate(input.root, input.binding, gate, input.principal, input.clock.now());
  return moved.status === "refused"
    ? { status: "refused", runId: input.binding.runId, reason: `gate resume: ${moved.reason}` } : null;
}

/**
 * An undecided gate: block durably and report `suspended-at-gate`. A LEADING
 * gate meets the run still `planned` and blocks from there too — otherwise the
 * caller is told "suspended" while no durable gate exists to decide.
 */
async function blockUndecidedGate(
  input: RunPreparationInputV1, gate: GatePhaseV1, state: PreparationRunV1["state"],
): Promise<RunPreparationResultV1> {
  if (state === "running" || state === "planned") {
    const moved = await blockAtGate(input.root, input.binding, gate, input.principal, input.clock.now());
    if (moved.status === "refused") {
      return { status: "refused", runId: input.binding.runId, reason: `gate block: ${moved.reason}` };
    }
  }
  return { status: "suspended-at-gate", runId: input.binding.runId };
}


/** One phase to committed, retrying only lock contention; null = settled. */
async function driveOnePhase(
  input: RunPreparationInputV1, logicalPhaseId: string, expansionIdentity: string,
): Promise<RunPreparationResultV1 | null> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") return { status: "refused", runId: input.binding.runId, reason: "run unreadable" };
  const phaseInstanceId = derivePhaseInstanceId({
    manifestDigest: input.binding.manifestDigest, logicalPhaseId, expansionIdentity,
  });
  const summary = read.run.phaseSummaries.find((entry) => entry.phaseInstanceId === phaseInstanceId);
  if (summary !== undefined && summary.state !== "pending" && summary.state !== "ready") return null;
  return attemptUntilSettled(input, phaseInstanceId, logicalPhaseId, summary?.attemptCount ?? 0);
}

/** Run attempts, retrying only lock contention under the bound; null = committed. */
async function attemptUntilSettled(
  input: RunPreparationInputV1, phaseInstanceId: ReturnType<typeof derivePhaseInstanceId>,
  logicalPhaseId: string, attemptIndex: number,
): Promise<RunPreparationResultV1 | null> {
  for (let busy = 0; ; busy += 1) {
    const outcome = await executePhaseAttempt({
      root: input.root, binding: input.binding, phaseInstanceId, logicalPhaseId,
      attemptIndex, authorityResolver: input.authorityResolver,
      leg: input.legFor(logicalPhaseId), principal: input.principal, clock: input.clock,
    });
    if (outcome.status === "committed") return null;
    if (outcome.status === "refused-busy" && busy < MAX_BUSY_RETRIES) continue;
    if (outcome.status === "refused-busy") return { status: "refused-busy", runId: input.binding.runId };
    return { status: outcome.status, runId: input.binding.runId, reason: outcome.reason };
  }
}

/**
 * Materialize once under the still-pinned contract and finalize; null = ok.
 * The materializer is handed the CAPTURED, BOUNDED bytes of the run's durable
 * evidence — read back through R1 under the plan's declared per-item cap — so
 * the obligation candidate is derived from what the attempts actually
 * persisted, not from anything the caller holds in memory.
 */
async function materializeAndFinalize(
  input: RunPreparationInputV1, materializer: PreparationMaterializerV1,
  limits: { manifestBytes: number; payloadBytes: number; evidenceItemBytes: number },
): Promise<RunPreparationResultV1 | null> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") return { status: "refused", runId: input.binding.runId, reason: "run unreadable" };
  const evidence = await readPayloadsBackByRefs(input, read.run, limits.evidenceItemBytes);
  if (typeof evidence === "string") return { status: "refused", runId: input.binding.runId, reason: evidence };
  let result: MaterializationResultV1;
  let payloads: Map<string, Buffer>;
  try {
    const produced = materializer.materialize({ run: read.run, evidence });
    result = captureMaterializationResult(produced.result);
    payloads = new Map();
    for (const bytes of produced.payloads.values()) {
      const copy = Buffer.from(bytes);
      payloads.set(createHash("sha256").update(copy).digest("hex"), copy);
    }
  } catch (cause) {
    if (cause instanceof NoObligationError) return settleWithNoObligation(input, read.run, cause);
    // Typed materialization refusals CARRY THEIR ATTRIBUTION (which phase,
    // which completeness class); masking them as "materializer failed" hid
    // the judge lane's stage-1/stage-2 distinction from every caller.
    const reason = cause instanceof MaterializationCaptureError || cause instanceof PackMaterializationError
      ? cause.message : "materializer failed";
    return { status: "refused", runId: input.binding.runId, reason };
  }
  const finalized = await finalizePreparationForHandoff({
    root: input.root, binding: input.binding, result,
    operationPrincipal: input.operationPrincipal, handlerContractDigest: input.handlerContractDigest,
    payloads, principal: input.principal, at: input.clock.now(),
  });
  if (finalized.status === "refused") {
    return { status: "refused", runId: input.binding.runId, reason: finalized.reason };
  }
  return null;
}

/**
 * Drive a run that proposed nothing to a TERMINAL state.
 *
 * WITHOUT THIS THE RUN STAYS `running`, and the next invocation drives it
 * again. For an idempotent workflow — seed a catalog, re-seed it — that is the
 * NORMAL path, so non-terminal runs accumulate on every repeat and eventually
 * consume the workspace's active-run capacity. A returned status is not a
 * durable outcome; only the transition is.
 *
 * `succeeded` is the honest terminal: the run did everything it was asked to
 * and found nothing left to do. It is not `failed` — nothing went wrong — and
 * not `handed-off`, which would claim a bundle that does not exist.
 */
async function settleWithNoObligation(
  input: RunPreparationInputV1, run: PreparationRunV1, cause: NoObligationError,
): Promise<RunPreparationResultV1> {
  try {
    await appendPreparationTransitionLocked(
      input.root, input.binding, preparationRunPredecessor(run),
      {
        type: "succeeded", stateAfter: "succeeded", payload: { kind: "none" },
        actor: input.principal, at: input.clock.now(),
      },
    );
  } catch (error) {
    // A run left mid-flight is worse than a reported refusal: say the terminal
    // transition failed rather than claim a settled no-op over a running run.
    return {
      status: "refused", runId: input.binding.runId,
      reason: `nothing to propose, but the run could not be settled: ${(error as Error).message}`,
    };
  }
  return { status: "nothing-to-propose", runId: input.binding.runId, reason: cause.detail };
}

/** Reconstruct obligations from the persisted manifest and hand off (§3.4). */
async function reconstructAndHandoff(
  input: RunPreparationInputV1,
  limits: { manifestBytes: number; payloadBytes: number },
  faults: RunnerFaultsForTestV1 | undefined,
): Promise<RunPreparationResultV1> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") return { status: "refused", runId: input.binding.runId, reason: "run unreadable" };
  const classified = classifyMaterializationManifests(read.run.evidenceRefs);
  if (classified.status !== "one") {
    return { status: "refused", runId: input.binding.runId, reason: `materialization manifests: ${classified.status}` };
  }
  const parsed = await readManifestBack(input, classified.ref.digest, limits.manifestBytes);
  if (typeof parsed === "string") return { status: "refused", runId: input.binding.runId, reason: parsed };
  const payloads = await readPayloadsBack(input, parsed.body, limits.payloadBytes);
  if (typeof payloads === "string") return { status: "refused", runId: input.binding.runId, reason: payloads };
  try {
    const settled = await handoffPreparation(input.root, handoffRequest(input, read.run, parsed, payloads, faults));
    return { status: settled.outcome, runId: input.binding.runId, bundleManifestDigest: settled.bundleManifestDigest };
  } catch (cause) {
    if (cause instanceof HandoffError) {
      return { status: "refused", runId: input.binding.runId, reason: `handoff: ${cause.message}` };
    }
    // A supersedesBundleId that fails BUNDLE-GRAPH validation (an unknown or
    // cross-workspace predecessor) is a DATA refusal, not a runner bug: honor the
    // result contract with a typed refusal. Match the graph error SPECIFICALLY, not
    // merely the presence of a supersede id — an unrelated fault (e.g. a malformed
    // obligation) must still surface, never be reclassified as a supersede refusal.
    if (cause instanceof Error && /bundle graph/i.test(cause.message)) {
      return { status: "refused", runId: input.binding.runId, reason: `supersede: ${cause.message}` };
    }
    throw cause;
  }
}

/** R1-read every durable evidence object the run's attempts recorded. */
async function readPayloadsBackByRefs(
  input: RunPreparationInputV1, run: PreparationRunV1, itemCap: number,
): Promise<Map<string, Buffer> | string> {
  const location = { workspaceId: input.binding.workspaceId, preparationId: input.binding.preparationId };
  const evidence = new Map<string, Buffer>();
  for (const ref of run.evidenceRefs) {
    const bare = ref.digest.startsWith("sha256:") ? ref.digest.slice("sha256:".length) : ref.digest;
    const bytes = await readPreparationEvidenceBytes(input.root, location, bare, itemCap);
    if (bytes.status !== "ok") return `attempt evidence ${bare} ${bytes.status}`;
    evidence.set(bare, bytes.bytes);
  }
  return evidence;
}

/** The declared materialization limits, or null when the plan is not runner-managed. */
async function declaredMaterializationLimits(
  input: RunPreparationInputV1,
): Promise<{ manifestBytes: number; payloadBytes: number; evidenceItemBytes: number } | null> {
  const manifest = await readPreparationManifest(input.root, input.binding.workspaceId, input.binding.preparationId);
  if (manifest.status !== "ok") return null;
  const capacity = manifest.manifest.plan.outputContract.handoffCapacity;
  const manifestBytes = capacity?.maximumMaterializationManifestBytes;
  const payloadBytes = capacity?.maximumMaterializationPayloadBytes;
  if (manifestBytes === undefined || capacity?.maximumMaterializationPayloadRefs === undefined
    || payloadBytes === undefined) return null;
  return { manifestBytes, payloadBytes, evidenceItemBytes: capacity.maximumRunEvidenceItemBytes };
}
