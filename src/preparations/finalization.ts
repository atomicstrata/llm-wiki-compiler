/**
 * @file src/preparations/finalization.ts
 * @description The production writer for the existing `running → handoff-ready`
 * edge (runner design v3 §6). Under the project lock it re-checks the
 * finalization preconditions, persists the canonical materialization manifest
 * and its payload objects as create-only evidence, and appends the transition
 * with the projector attaching evidence refs, completeness, and warnings to
 * run-content fields that already exist. Nothing new is carried on the
 * transition itself (`handoff-ready` keeps its `nonePayload`).
 *
 * CORE STAMPS THE AUTHORITY, THE MATERIALIZER NEVER SEES IT. `grantDigest` is
 * derived here through the resolver's own exported rule over the host-resolved
 * operation principal, and `actor` is written from that same principal — the
 * captured materializer result has no actor member to begin with, and an
 * attempt to smuggle one was already refused at capture.
 *
 * EVERY REFUSAL LEAVES THE RUN `running`. A refused finalization strands
 * nothing: cancel, fail, and recovery remain exactly as reachable as before,
 * and the caller may re-derive and retry. Crash between the evidence writes
 * and the transition is re-drivable — the evidence store is create-only and
 * content-addressed, so an identical re-derivation lands as `"same"` and the
 * append proceeds from the unchanged `running` predecessor.
 *
 * ONE BODY, {@link finalizePreparationForHandoffWith}, over {@link FinalizationSteps}
 * (the blocking lock, the run, the cancellation poll, the plan's manifest, the
 * evidence writer, the projected append) and an input that carries no root. The
 * lock is the one MECHANISM the steps carry. The root form keeps its signature,
 * captures its input exactly as before and passes the local steps for the
 * captured root, which call the incumbents when asked;
 * {@link finalizationStepsOver} composes them from each one's own body.
 */

import { createHash } from "node:crypto";
import { recomputeGrantDigest } from "../operation-bundles/operations-authority-resolver.js";
import type { OperationPrincipal } from "../operation-bundles/principal.js";
import type { Sha256Digest } from "../capability-providers/types.js";
import { assertCompletenessPermitsSuccess, toRunCompletenessRecord, type PreparationCompletenessV1 } from "./completeness.js";
import {
  preparationCancellationRequested, preparationCancellationRequestedFrom,
  type PreparationCancelLeaves, type PreparationCancellationProbe,
} from "./cancellation.js";
import {
  writePreparationEvidenceCreateOnly, writePreparationEvidenceCreateOnlyWith,
  type EvidenceWriteResult, type PreparationEvidenceLocation, type PreparationEvidenceWriteSteps,
} from "./evidence-store.js";
import { ownerProcessIsLive } from "./attempts/lease.js";
import { diskGateDriverSteps } from "./gate-driver.js";
import {
  MATERIALIZATION_MANIFEST_KIND, serializeMaterializationManifest,
  type MaterializationResultV1, type PreparationHandoffMaterializationV1,
} from "./materialization.js";
import {
  readPreparationManifest, readPreparationManifestFrom, type PreparationManifestLeafReads, type PreparationManifestRead,
} from "./manifest-store.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import {
  appendPreparationTransitionWith, readPreparationRunFrom,
  type PreparationRunContentProjector, type PreparationRunLeafReads, type PreparationRunRead, type PreparationRunWriteSteps,
} from "./run-store.js";
import type { EvidenceRefV1 } from "./types.js";
import type {
  AppendPreparationTransitionInput, PhaseSummaryV1, PreparationPrincipalV1, PreparationRunBinding,
  PreparationRunPredecessor, PreparationRunV1,
} from "./run-types.js";

/** Input to one finalization: durable identities plus the captured material. */
export interface FinalizationInputV1 {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  /** The captured materializer result — actor-less by construction. */
  readonly result: MaterializationResultV1;
  /** The host-resolved Milestone A principal (design §5b). */
  readonly operationPrincipal: OperationPrincipal;
  /** The plan's pinned handler contract digest. */
  readonly handlerContractDigest: Sha256Digest;
  /** Payload bytes keyed by bare-hex sha256 — must cover every payload ref. */
  readonly payloads: ReadonlyMap<string, Buffer>;
  /** The preparation-side actor recorded on the transition. */
  readonly principal: PreparationPrincipalV1;
  /** The transition instant, host-sampled. */
  readonly at: string;
}

/** Closed outcome of one finalization. */
export type FinalizationResultV1 =
  | { readonly status: "finalized"; readonly run: PreparationRunV1; readonly manifestDigest: string }
  | { readonly status: "refused"; readonly reason: string };

/** What the finalization body reads off its input: everything but the project root. */
export type FinalizationBodyInputV1 = Omit<FinalizationInputV1, "root">;

/** What one finalization asks for, in order. No member takes a project root. */
export interface FinalizationSteps {
  /** The blocking project lock: a MECHANISM, no decision. */
  readonly lock: { acquire(): Promise<void>; release(): Promise<void> };
  /** The run at `binding`, authenticated. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  /** Whether a valid cancellation is requested for the run. */
  readonly cancellationRequested: PreparationCancellationProbe;
  /** The plan's immutable manifest. */
  readManifest(workspaceId: string, preparationId: PreparationRunBinding["preparationId"]): Promise<PreparationManifestRead>;
  /** Create one immutable evidence object, or prove its exact replay. */
  writeEvidence(location: PreparationEvidenceLocation, bytes: Buffer): Promise<EvidenceWriteResult>;
  /** The projected append fenced to `expected`. */
  appendProjected(
    binding: PreparationRunBinding, expected: PreparationRunPredecessor,
    input: AppendPreparationTransitionInput, project: PreparationRunContentProjector,
  ): Promise<PreparationRunV1>;
}

/**
 * LOCAL DISK. The incumbent lock, readers and writers for `root`, each called when
 * asked. The lock, the run read and the append are the gate driver's
 * (`diskGateDriverSteps`): ONE HOLD's run and key reads, ended by the append. The
 * evidence written between the read and the append is not the run or the key.
 */
function diskFinalizationSteps(root: string): FinalizationSteps {
  return {
    ...diskGateDriverSteps(root),
    cancellationRequested: (workspaceId, runId) => preparationCancellationRequested(root, workspaceId, runId),
    readManifest: (workspaceId, preparationId) => readPreparationManifest(root, workspaceId, preparationId),
    writeEvidence: (location, bytes) => writePreparationEvidenceCreateOnly(root, location, bytes),
  };
}

/** The same steps over each store's own body, under the caller's `lock`. Building it does no I/O. */
export function finalizationStepsOver(sources: {
  runs: PreparationRunLeafReads; advisories: PreparationCancelLeaves; manifests: PreparationManifestLeafReads;
  evidence: PreparationEvidenceWriteSteps; writes: PreparationRunWriteSteps;
}, lock: FinalizationSteps["lock"]): FinalizationSteps {
  return {
    lock,
    readRun: (binding) => readPreparationRunFrom(sources.runs, binding),
    cancellationRequested: (workspaceId, runId) => preparationCancellationRequestedFrom(sources.advisories, workspaceId, runId),
    readManifest: (workspaceId, preparationId) => readPreparationManifestFrom(sources.manifests, workspaceId, preparationId),
    writeEvidence: (location, bytes) => writePreparationEvidenceCreateOnlyWith(sources.evidence, location, bytes),
    appendProjected: (binding, expected, input, project) => appendPreparationTransitionWith(sources.writes, binding, expected, input, project),
  };
}

/** Phase-summary states that permit finalization (settled without fault). */
const FINALIZABLE_PHASE_STATES = new Set<PhaseSummaryV1["state"]>([
  "succeeded", "succeeded-with-warnings", "skipped-optional",
]);

/**
 * Terminal states a REQUIRED phase may not carry into handoff but an OPTIONAL one
 * may: an optional phase that failed or was cancelled does not block the run — the
 * work it would have contributed is simply absent, surfaced as a completeness
 * deficit. A required fault still refuses (Chunk 3 unit E, optional rendering).
 */
const OPTIONAL_TOLERATED_STATES = new Set<PhaseSummaryV1["state"]>(["failed", "cancelled"]);

/** Whether one phase summary blocks finalization: a required fault does, an optional one does not. */
function blocksFinalization(summary: PhaseSummaryV1): boolean {
  if (FINALIZABLE_PHASE_STATES.has(summary.state)) return false;
  return !(summary.disposition === "optional" && OPTIONAL_TOLERATED_STATES.has(summary.state));
}

/** Finalize one running preparation into `handoff-ready`, under the lock. */
export async function finalizePreparationForHandoff(
  callerInput: FinalizationInputV1,
): Promise<FinalizationResultV1> {
  // The root comes off the SAME synchronous capture the body takes, read once.
  const input = capturedFinalizationInput(callerInput);
  return finalizePreparationForHandoffWith(diskFinalizationSteps(input.root), input);
}

/** {@link finalizePreparationForHandoff} over {@link FinalizationSteps}: THE ONE BODY. */
export async function finalizePreparationForHandoffWith(
  steps: FinalizationSteps, callerInput: FinalizationBodyInputV1,
): Promise<FinalizationResultV1> {
  const input = capturedFinalizationInput(callerInput);
  await steps.lock.acquire();
  try {
    return await finalizeLocked(steps, input);
  } finally {
    await steps.lock.release();
  }
}

/**
 * Capture identities SYNCHRONOUSLY before the first await: the manifest stamps
 * grantDigest and actor from these, and a caller mutating a retained principal
 * after invocation must not change what durable evidence records.
 */
function capturedFinalizationInput<T extends FinalizationBodyInputV1>(callerInput: T): T {
  return {
    ...callerInput,
    binding: { ...callerInput.binding },
    principal: { ...callerInput.principal },
    operationPrincipal: {
      id: callerInput.operationPrincipal.id, surface: callerInput.operationPrincipal.surface,
      grants: [...callerInput.operationPrincipal.grants],
    },
    payloads: new Map(callerInput.payloads),
  };
}

/** The locked body: precondition sweep, evidence persist, transition append. */
async function finalizeLocked(steps: FinalizationSteps, input: FinalizationBodyInputV1): Promise<FinalizationResultV1> {
  const read = await steps.readRun(input.binding);
  if (read.status !== "ok") return refusal(`run unreadable: ${read.status}`);
  const run = read.run;
  const refused = await finalizationRefusal(steps, input, run);
  if (refused !== null) return refused;

  const limits = await declaredLimits(steps, input);
  if ("status" in limits) return limits;
  const manifest = coreStampedManifest(input, run.runId);
  const bytes = serializeMaterializationManifest(manifest);
  const overBudget = budgetRefusal(bytes, input, limits);
  if (overBudget !== null) return overBudget;
  const payloadProblem = payloadCoverageRefusal(input);
  if (payloadProblem !== null) return payloadProblem;

  for (const [digest, payload] of input.payloads) {
    void digest;
    await steps.writeEvidence(evidenceLocation(input), payload);
  }
  await steps.writeEvidence(evidenceLocation(input), bytes);
  const manifestDigest = createHash("sha256").update(bytes).digest("hex");
  const next = await steps.appendProjected(
    input.binding, preparationRunPredecessor(run),
    { type: "handoff-ready", stateAfter: "handoff-ready", payload: { kind: "none" }, actor: input.principal, at: input.at },
    finalizationProjector(input, manifestDigest, bytes.byteLength),
  );
  return { status: "finalized", run: next, manifestDigest };
}

/** Every precondition, re-checked under the lock; `null` means clear to go. */
async function finalizationRefusal(
  steps: FinalizationSteps, input: FinalizationBodyInputV1, run: PreparationRunV1,
): Promise<FinalizationResultV1 | null> {
  if (run.state !== "running") return refusal(`run state is ${run.state}, not running`);
  if (run.executionOwner !== undefined) {
    return refusal(ownerProcessIsLive(run.executionOwner)
      ? "an attempt lease is live" : "a dead attempt lease awaits recovery");
  }
  if (await steps.cancellationRequested(input.binding.workspaceId, run.runId)) {
    return refusal("a cancellation is pending");
  }
  if (run.phaseSummaries.length === 0) return refusal("no phase has settled");
  const unsettled = run.phaseSummaries.find(blocksFinalization);
  if (unsettled !== undefined) {
    return refusal(`phase ${unsettled.phaseInstanceId} is ${unsettled.state}`);
  }
  try {
    assertCompletenessPermitsSuccess(input.result.completeness as PreparationCompletenessV1);
  } catch (cause) {
    return refusal(`completeness refuses success: ${(cause as Error).message}`);
  }
  return null;
}

/** The plan's declared materialization limits; refusal when not runner-managed. */
async function declaredLimits(
  steps: FinalizationSteps, input: FinalizationBodyInputV1,
): Promise<{ manifestBytes: number; payloadRefs: number; payloadBytes: number } | FinalizationResultV1> {
  const manifest = await steps.readManifest(input.binding.workspaceId, input.binding.preparationId);
  if (manifest.status !== "ok") return refusal(`preparation manifest unreadable: ${manifest.status}`);
  const capacity = manifest.manifest.plan.outputContract.handoffCapacity;
  const manifestBytes = capacity?.maximumMaterializationManifestBytes;
  const payloadRefs = capacity?.maximumMaterializationPayloadRefs;
  const payloadBytes = capacity?.maximumMaterializationPayloadBytes;
  if (manifestBytes === undefined || payloadRefs === undefined || payloadBytes === undefined) {
    return refusal("plan does not declare the materialization limits");
  }
  return { manifestBytes, payloadRefs, payloadBytes };
}

/** Enforce the declared limits again at write time — never an over-budget write. */
function budgetRefusal(
  bytes: Buffer, input: FinalizationBodyInputV1,
  limits: { manifestBytes: number; payloadRefs: number; payloadBytes: number },
): FinalizationResultV1 | null {
  if (bytes.byteLength > limits.manifestBytes) {
    return refusal(`manifest is ${bytes.byteLength} bytes, over the declared ${limits.manifestBytes}`);
  }
  if (input.result.payloadRefs.length > limits.payloadRefs) {
    return refusal(`materialization declares ${input.result.payloadRefs.length} payload refs, over ${limits.payloadRefs}`);
  }
  const total = input.result.payloadRefs.reduce((sum, ref) => sum + ref.byteCount, 0);
  if (total > limits.payloadBytes) {
    return refusal(`payload bytes ${total} exceed the declared ${limits.payloadBytes}`);
  }
  return null;
}

/**
 * Require EXACT bidirectional coverage: every ref has its bytes, digest-exact,
 * and every supplied payload is referenced. The reverse direction is
 * load-bearing — the write loop persists the whole map, so an unreferenced
 * extra entry would be evidence bytes the declared budget never accounted for
 * (adversarial round 2: a 100 KB orphan rode past a 64 KB budget this way).
 */
function payloadCoverageRefusal(input: FinalizationBodyInputV1): FinalizationResultV1 | null {
  const referenced = new Set(input.result.payloadRefs.map((ref) => ref.digest));
  for (const supplied of input.payloads.keys()) {
    if (!referenced.has(supplied)) return refusal(`payload ${supplied} is supplied but unreferenced`);
  }
  for (const ref of input.result.payloadRefs) {
    const bytes = input.payloads.get(ref.digest);
    if (bytes === undefined) return refusal(`payload ${ref.digest} is not supplied`);
    if (bytes.byteLength !== ref.byteCount) return refusal(`payload ${ref.digest} byte count mismatch`);
    if (createHash("sha256").update(bytes).digest("hex") !== ref.digest) {
      return refusal(`payload ${ref.digest} bytes do not hash to their key`);
    }
  }
  return null;
}

/** Build the manifest with the two core-stamped authority fields (§6). */
function coreStampedManifest(
  input: FinalizationBodyInputV1, runId: string,
): PreparationHandoffMaterializationV1 {
  return {
    schemaVersion: 1,
    kind: MATERIALIZATION_MANIFEST_KIND,
    runId,
    handlerContractDigest: input.handlerContractDigest,
    grantDigest: recomputeGrantDigest(input.operationPrincipal) as unknown as Sha256Digest,
    actor: {
      id: input.operationPrincipal.id,
      surface: input.operationPrincipal.surface,
      grants: [...input.operationPrincipal.grants],
    },
    body: input.result,
  };
}

/** Attach the manifest ref, payload refs, completeness, and warnings. */
function finalizationProjector(
  input: FinalizationBodyInputV1, manifestDigest: string, manifestBytes: number,
): PreparationRunContentProjector {
  const completeness = input.result.completeness as PreparationCompletenessV1;
  return (next) => ({
    ...next,
    evidenceRefs: [...next.evidenceRefs, manifestRef(manifestDigest, manifestBytes, input),
      ...input.result.payloadRefs.map((ref) => payloadEvidenceRef(ref, input))],
    // The CANONICAL projection — classDigest is identitySetsDigest, which
    // moves with the eligibility universe; scopeDigest is designed to stay
    // stable while work proceeds and must never be keyed on here.
    completeness: toRunCompletenessRecord(completeness),
    ...(input.result.completionWarnings === undefined ? {} : {
      completionWarnings: [...next.completionWarnings,
        ...(input.result.completionWarnings as unknown as typeof next.completionWarnings)],
    }),
  });
}

/** The manifest's own evidence ref — the exactly-one restart anchor. */
function manifestRef(
  digest: string, byteCount: number, input: FinalizationBodyInputV1,
): EvidenceRefV1 {
  // Run-attached refs carry the PREFIXED canonical digest form (the run
  // parser enforces it); the bare hex remains the evidence store's CAS key.
  return {
    kind: MATERIALIZATION_MANIFEST_KIND, mediaType: "application/json",
    provenanceLabel: "core-finalization", digest: `sha256:${digest}` as Sha256Digest, byteCount,
    sensitivity: "ordinary", retention: "until-handoff",
    producer: { kind: "host", contractDigest: input.handlerContractDigest },
    untrusted: true,
  };
}

/** One payload object's evidence ref, mirrored from its materialized ref. */
function payloadEvidenceRef(
  ref: MaterializationResultV1["payloadRefs"][number], input: FinalizationBodyInputV1,
): EvidenceRefV1 {
  return {
    kind: "materialization-payload", mediaType: ref.mediaType,
    provenanceLabel: `core-finalization:${ref.role}`, digest: `sha256:${ref.digest}` as Sha256Digest,
    byteCount: ref.byteCount, sensitivity: "ordinary", retention: "until-handoff",
    producer: { kind: "host", contractDigest: input.handlerContractDigest },
    untrusted: true,
  };
}

/** Evidence location for this run's preparation. */
function evidenceLocation(input: FinalizationBodyInputV1): { workspaceId: string; preparationId: PreparationRunBinding["preparationId"] } {
  return { workspaceId: input.binding.workspaceId, preparationId: input.binding.preparationId };
}

/** One typed refusal; the run stays `running` and every exit stays reachable. */
function refusal(reason: string): FinalizationResultV1 {
  return { status: "refused", reason };
}
