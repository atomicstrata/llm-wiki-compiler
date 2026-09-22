/**
 * @file src/viewer/workflow-run-projection.ts
 * @description The GENERIC, request-time per-run stage projection the viewer serves
 * at `/api/workflows/:workflowId/runs/:runId` (P9.1). It is workflow-AGNOSTIC — it
 * reads only core workflow seams (`readRun`, `classifyRun`, `lookupWorkflowDef`) and
 * projects each stage's generic status + gate lifecycle. Scientific presentation
 * compatibility is isolated in `compat/`; this module never interprets a
 * stage's recorded output beyond its opaque artifact ref.
 *
 * "What happened scientifically" is NOT core's to assert: a recorded checkpoint is a
 * grant-writable artifact, so a bare row is `recorded-only` (generic status + gate
 * lifecycle, no provenance-as-fact). A PRODUCT may inject a
 * {@link LiveStageProjectionProvider} (construction-time DI) that RE-VERIFIES a run's
 * stages live and contributes verified facts; core validates that contribution against
 * the run's identity + `stateVersion` + the active profile digest AND a bounded,
 * well-formed DTO, and on ANY failure (throw, timeout, drift, malformed) DEGRADES to
 * recorded-only (never a 500, never provenance the product did not authenticate).
 *
 * Anchor contract: within one attempt the projection derives from ONE `loadProfile` +
 * ONE `readRun`, so classification (`classifyRun`) and the roster (`lookupWorkflowDef`)
 * never split across two loads. Any provider is bound to that attempt's {run version,
 * profile digest} anchor — a reactivation does NOT bump the run version, so the digest
 * is what stops facts verified under profile B from merging with roster A. After the
 * build, both authorities are RE-READ; a mid-build drift retries for a stable pass and,
 * after {@link MAX_BUILD_ATTEMPTS}, degrades to recorded-only rather than splice.
 */

import type { ServerResponse } from "http";
import { readRun } from "../workflow-history/store.js";
import { classifyRun, type RunClassification } from "../workflow-history/status.js";
import { lookupWorkflowDef } from "../workflow-history/definition.js";
import { workflowDefDigest } from "../profile/workflow-digest.js";
import { parseGate } from "../workflow-history/gates.js";
import type { GateKind } from "../workflow-history/gates.js";
import { loadProfile } from "../profile/load.js";
import { applyLiveStageProvider } from "./workflow-run-facts.js";
import type { WorkflowRun, WorkflowActorKind, WorkflowEvent } from "../workflow-history/types.js";
import type { WorkflowDef } from "../profile/types.js";
import type { VerifiedExperimentStateV1 } from "./compat/experiment-state.js";
export type { VerifiedExperimentStateV1 } from "./compat/experiment-state.js";

/** The minimum wait for a never-settling provider before the live route degrades. */
const MIN_PROVIDER_TIMEOUT_MS = 60_000;
/**
 * Per-stage verification allowance. Measured at about 0.15 s/stage locally and 0.5 s/stage on
 * hosted runners, but a loaded runner overran 1 s/stage re-verifying a completed journey, and a
 * silently recorded-only page reads as "not verified". A fast provider never waits for this
 * budget, and a timed-out one is reported on the envelope (D-VIEW-BUDGET-DEFAULT).
 */
const PROVIDER_TIMEOUT_PER_STAGE_MS = 10_000;
/** Re-projection attempts when the profile/run drifts mid-build before degrading to recorded-only. */
const MAX_BUILD_ATTEMPTS = 3;

/** How a stage's gate stands right now, relative to the run's progress. */
export type StageGateState = "not-reached" | "awaiting" | "approved";

/** A stage's gate lifecycle projection; absent for a stage that declares no gate. */
export interface StageGateProjection {
  readonly gateId: string;
  /** The gate's kind — lets a client label a HUMAN approval distinctly from an agent/trust gate. */
  readonly gateKind: GateKind;
  readonly state: StageGateState;
  /** The recorded approval decision, actor, and time — present only once approved. */
  readonly decision?: string;
  readonly actor?: string;
  /** Who performed the approval (human/agent/system) — present only when a gate-approved event recorded it. */
  readonly actorKind?: WorkflowActorKind;
  readonly at?: string;
  /** Exact subject digest recorded by a subject-bound approval. */
  readonly subjectDigest?: string;
}

/** A generic, run-bound artifact ref a stage recorded — projected opaquely, never read. */
export interface StageOutputRef {
  readonly artifactType: string;
  readonly slug: string;
  readonly sha256: string;
}

/** Closed presentation tones for one verified generic fact. */
export type VerifiedFactToneV1 = "neutral" | "success" | "warning" | "danger";

/** One bounded label/value row in a product-neutral verified fact panel. */
export interface VerifiedFactRowV1 {
  readonly label: string;
  readonly value: string;
  readonly tone: VerifiedFactToneV1;
}

/** One optional verified panel contributed by a product projection provider. */
export interface VerifiedFactPanelV1 {
  readonly title: string;
  readonly rows: readonly VerifiedFactRowV1[];
}

/** The verified provenance a PRODUCT provider contributes for one stage (once re-verified). */
export interface VerifiedStageFactsV1 {
  readonly stageId: string;
  readonly summary: string;
  readonly appliedTargets: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly groundedRefs?: readonly string[];
  readonly pdfRef?: StageOutputRef & { readonly member: string };
  /** @deprecated Compatibility input for archived providers; prefer factPanel. */
  readonly experimentState?: VerifiedExperimentStateV1;
  readonly factPanel?: VerifiedFactPanelV1;
}

/** Why a stage could not be reverified during this request. */
export interface StageVerificationReasonV1 {
  readonly category: "stale-or-invalid" | "unavailable" | "timed-out";
  readonly code: string;
}

/** One product-declared stage verification failure, never a fact carrier. */
export interface StageVerificationFailureV1 extends StageVerificationReasonV1 {
  readonly stageId: string;
}

/**
 * One stage's projection — a DISCRIMINATED UNION so an unverified row STRUCTURALLY
 * cannot carry verified provenance (`verified` fields exist only on the verified arm).
 */
export type StageProjection =
  | {
      readonly stageId: string;
      readonly status: string;
      readonly gate?: StageGateProjection;
      readonly outputRef?: StageOutputRef;
      readonly verification: "recorded-only";
      readonly verificationReason?: StageVerificationReasonV1;
    }
  | (VerifiedStageFactsV1 & {
      readonly stageId: string;
      readonly status: string;
      readonly gate?: StageGateProjection;
      readonly outputRef?: StageOutputRef;
      readonly verification: "verified";
    });

/**
 * Why an envelope built WITH a provider shows what it shows: its facts were applied, it timed
 * out (the budget, so the viewer can name the knob), it degraded (throw, unbound anchor, or a
 * malformed payload), or the run drifted mid-build and the recorded-only view was served.
 */
export type LiveProjectionOutcome =
  | { readonly outcome: "applied" }
  | { readonly outcome: "timed-out"; readonly timeoutMs: number }
  | { readonly outcome: "degraded" }
  | { readonly outcome: "drifted" };

/** The live per-run projection envelope the route returns for a readable, matching run. */
export interface WorkflowRunProjectionEnvelope {
  readonly workflowId: string;
  readonly runId: string;
  readonly stateVersion: number;
  readonly classification: RunClassification;
  readonly generatedAt: string;
  readonly productId?: string;
  readonly processDefinitionDigest?: string;
  readonly runtimeAuthorityDigest?: string;
  readonly workspaceId?: string;
  readonly workspaceCompositionDigest?: string;
  readonly stages: readonly StageProjection[];
  /** Present only when a provider was configured. */
  readonly live?: LiveProjectionOutcome;
}

/** A fail-VISIBLE problem envelope (unreadable run, workflow mismatch) — never a 500. */
export interface WorkflowRunProblem {
  readonly workflowId: string;
  readonly runId: string;
  readonly problem: string;
}

/**
 * The authorities a verified projection is bound to: the run's monotonic `stateVersion`
 * AND the active profile's `profileDigest`. BOTH matter — a profile reactivation does
 * NOT bump the run version, so binding version alone would let facts verified under
 * profile B merge with classification/roster from profile A and still read verified.
 */
export interface RunProjectionAnchor {
  readonly stateVersion: number;
  readonly profileDigest: string;
}

/** What a live provider returns: its OWN re-verified per-stage facts, bound to the anchor. */
export interface LiveStageProjectionResult extends RunProjectionAnchor {
  readonly workflowId: string;
  readonly runId: string;
  readonly stages: readonly VerifiedStageFactsV1[];
  readonly failures?: readonly StageVerificationFailureV1[];
}

/**
 * A construction-time-injected provider that RE-VERIFIES a run's stages LIVE and
 * returns verified facts. GENERIC by design: core calls it by ids + the expected
 * anchor (run version + profile digest) and knows nothing of the product; a product
 * package implements it (P9.2). Absent on the plain `llmwiki view` — every stage is
 * recorded-only. Core applies its result ONLY when the returned anchor + identity + a
 * bounded, well-formed DTO all check out, else DEGRADES to recorded-only.
 */
export type LiveStageProjectionProvider = (
  root: string,
  workflowId: string,
  runId: string,
  expected: RunProjectionAnchor,
) => Promise<LiveStageProjectionResult>;

/** Optional construction-time deps threaded through the viewer request path. */
export interface ViewerDeps {
  readonly liveStageProjectionProvider?: LiveStageProjectionProvider;
}

/** Default provider budget: a sixty-second floor, then ten seconds per recorded stage. */
export function providerTimeoutMsForStageCount(stageCount: number): number {
  return Math.max(MIN_PROVIDER_TIMEOUT_MS, PROVIDER_TIMEOUT_PER_STAGE_MS * stageCount);
}

/** Coerce a stage's opaque recorded output into a generic ref, or undefined. */
function coerceOutputRef(recorded: unknown): StageOutputRef | undefined {
  if (typeof recorded !== "object" || recorded === null) return undefined;
  const ref = recorded as Record<string, unknown>;
  if (typeof ref.artifactType !== "string" || typeof ref.slug !== "string" || typeof ref.sha256 !== "string") {
    return undefined;
  }
  return { artifactType: ref.artifactType, slug: ref.slug, sha256: ref.sha256 };
}

/**
 * The recorded approval audit (decision/actor/time) for a stage's satisfied gate.
 * TOLERANT of missing history: a satisfied gate with NO recorded gate-approved event
 * reads as `approved` WITHOUT a fabricated byline (actorKind/actor/at stay undefined).
 */
function approvedGateProjection(gateId: string, gateKind: GateKind, run: WorkflowRun, stageId: string): StageGateProjection {
  const event = latestApproval(run, stageId, gateId);
  return {
    gateId, gateKind, state: "approved",
    decision: event?.decision, actor: event?.actorLabel, actorKind: event?.actorKind, at: event?.at,
    subjectDigest: event?.subjectDigest,
  };
}

/**
 * The MOST RECENT `gate-approved` event for a stage's gate. A failed stage can be
 * resumed (clearing `satisfiedGates` but retaining the append-only event log) and
 * re-approved by a new actor, so the byline must reflect the LAST approval — not the
 * first `find()` match, which would attribute the current approval to a stale actor.
 */
function latestApproval(run: WorkflowRun, stageId: string, gateId: string): WorkflowEvent | undefined {
  let latest: WorkflowEvent | undefined;
  for (const event of run.events) {
    if (event.type === "gate-approved" && event.stageId === stageId && event.gateId === gateId) latest = event;
  }
  return latest;
}

/** True when the run is CURRENTLY parked awaiting a gate on this exact stage. */
function isAwaitingGateHere(run: WorkflowRun, stageId: string): boolean {
  if (run.currentStage !== stageId) return false;
  return run.stageLog.find((e) => e.stageId === stageId)?.status === "awaiting-gate";
}

/** Project a stage's gate lifecycle (not-reached / awaiting / approved + audit). */
function projectStageGate(gate: string | undefined, stageId: string, run: WorkflowRun): StageGateProjection | undefined {
  if (gate === undefined) return undefined;
  const parsed = parseGate(gate);
  const gateId = parsed?.id ?? gate;
  // A persisted gate passed the profile validator's GATE_PATTERN, so parse succeeds;
  // `trust` is a fail-closed fallback that never mislabels an unparseable gate as human.
  const gateKind = parsed?.kind ?? "trust";
  if (run.satisfiedGates.includes(gate)) return approvedGateProjection(gateId, gateKind, run, stageId);
  return { gateId, gateKind, state: isAwaitingGateHere(run, stageId) ? "awaiting" : "not-reached" };
}

/** Project one stage into a recorded-only row (generic status + gate lifecycle + output ref). */
function projectRecordedStage(stageId: string, gate: string | undefined, run: WorkflowRun, unloggedStatus: string): StageProjection {
  const status = run.stageLog.find((e) => e.stageId === stageId)?.status ?? unloggedStatus;
  const gateProjection = projectStageGate(gate, stageId, run);
  const outputRef = coerceOutputRef(run.outputs[stageId]);
  return {
    stageId,
    status,
    ...(gateProjection === undefined ? {} : { gate: gateProjection }),
    ...(outputRef === undefined ? {} : { outputRef }),
    verification: "recorded-only",
  };
}

/** Flatten optional product-process authority into the public run envelope. */
function projectedProcessAuthority(run: WorkflowRun) {
  const authority = run.processAuthority;
  if (authority === undefined) return {};
  return {
    productId: authority.productId,
    processDefinitionDigest: authority.processDefinitionDigest,
    runtimeAuthorityDigest: authority.runtimeAuthorityDigest,
    workspaceId: authority.workspaceId,
    workspaceCompositionDigest: authority.workspaceCompositionDigest,
  };
}

/**
 * The generic stage roster. The active workflow def supplies the roster + gate strings
 * ONLY when its digest still matches the run's sealed `workflowDigest` — for a changed
 * (needs-adaptation) or removed/terminal (historical) workflow, a mismatched def would
 * display stages and gates the run never had, so we fall back to the run's OWN recorded
 * stage ids WITHOUT unauthenticated current gate metadata. The `classification` field
 * tells the consumer which case this is.
 */
function stageRoster(run: WorkflowRun, def: WorkflowDef | undefined): { stageId: string; gate?: string }[] {
  if (def !== undefined && workflowDefDigest(def) === run.workflowDigest) {
    return def.stages.map((stage) => ({ stageId: stage.id, gate: stage.gate }));
  }
  return run.knownStageIds.map((stageId) => ({ stageId }));
}

/** One outcome of a single projection attempt: a fail-visible problem, or a built pair + freshness. */
type ProjectionAttempt =
  | { readonly kind: "problem"; readonly problem: WorkflowRunProblem }
  | {
      readonly kind: "ok";
      readonly stable: boolean;
      readonly envelope: WorkflowRunProjectionEnvelope;
      readonly recordedOnly: WorkflowRunProjectionEnvelope;
    };

/** True when the run version + profile digest are UNCHANGED since the anchor was taken. */
async function isStillFresh(root: string, runId: string, anchor: RunProjectionAnchor): Promise<boolean> {
  const [read, loaded] = await Promise.all([readRun(root, runId), loadProfile(root)]);
  return read.status === "ok" && read.run.stateVersion === anchor.stateVersion && loaded.digest === anchor.profileDigest;
}

/**
 * ONE projection attempt: read the run + load the profile ONCE, project the roster, apply
 * an optional provider (bound to the run-version + profile-digest anchor), then RE-READ
 * both to report whether the profile/run drifted mid-build. Both the verified and the
 * recorded-only envelope are returned so the caller can fall back without re-projecting.
 */
async function projectRunOnce(
  root: string, workflowId: string, runId: string,
  provider: LiveStageProjectionProvider | undefined, timeoutMs: number | undefined,
): Promise<ProjectionAttempt> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") {
    const detail = read.status === "unavailable" ? read.detail : read.status;
    return { kind: "problem", problem: { workflowId, runId, problem: `run is not readable (${detail})` } };
  }
  const run = read.run;
  if (run.workflowId !== workflowId) {
    return { kind: "problem", problem: { workflowId, runId, problem: `run belongs to workflow "${run.workflowId}", not "${workflowId}"` } };
  }
  const loaded = await loadProfile(root);
  const anchor: RunProjectionAnchor = { stateVersion: run.stateVersion, profileDigest: loaded.digest };
  const classification = classifyRun(run, loaded.profile);
  const def = lookupWorkflowDef(loaded.profile.workflows, run.workflowId);
  // A stage with no log entry is genuinely "pending" for a live run, but a terminal/
  // historical tombstone can carry a full roster with an erased log — reporting those as
  // "pending" would fabricate progress, so an unlogged stage of a historical run is "unknown".
  const unlogged = classification === "historical" ? "unknown" : "pending";
  const recorded = stageRoster(run, def).map((entry) => projectRecordedStage(entry.stageId, entry.gate, run, unlogged));
  const providerTimeoutMs = timeoutMs ?? providerTimeoutMsForStageCount(run.stageLog.length);
  const applied = provider === undefined ? undefined
    : await applyLiveStageProvider(recorded, provider, root, run, anchor, providerTimeoutMs);
  const base = {
    workflowId, runId, stateVersion: run.stateVersion, classification,
    generatedAt: new Date().toISOString(), ...projectedProcessAuthority(run),
  };
  const envelope = applied === undefined ? { ...base, stages: recorded } : { ...base, stages: applied.stages, live: applied.live };
  const drifted: LiveProjectionOutcome = { outcome: "drifted" };
  const recordedOnly = { ...base, stages: recorded, ...(applied === undefined ? {} : { live: drifted }) };
  return { kind: "ok", stable: await isStillFresh(root, runId, anchor), envelope, recordedOnly };
}

/**
 * Build the generic projection for one run at request time. Fail-VISIBLE (never a throw):
 * an unreadable run or workflow-id mismatch is a {@link WorkflowRunProblem}. Each attempt
 * reads the run + loads the profile ONCE and binds any provider to that exact anchor; if
 * the profile/run drifts DURING the build (a reactivation does not bump the run version),
 * it retries for a stable pass and, after {@link MAX_BUILD_ATTEMPTS}, degrades to the
 * recorded-only view — never a splice of one version's roster with another's facts.
 */
export async function buildWorkflowRunProjection(
  root: string, workflowId: string, runId: string,
  provider?: LiveStageProjectionProvider, timeoutMs?: number,
): Promise<WorkflowRunProjectionEnvelope | WorkflowRunProblem> {
  let recordedFallback: WorkflowRunProjectionEnvelope | undefined;
  for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt++) {
    const outcome = await projectRunOnce(root, workflowId, runId, provider, timeoutMs);
    if (outcome.kind === "problem") return outcome.problem;
    if (outcome.stable) return outcome.envelope;
    recordedFallback = outcome.recordedOnly;
  }
  return recordedFallback ?? { workflowId, runId, problem: "run state changed during projection" };
}

/** Parse `/api/workflows/:workflowId/runs/:runId` into its two ids, or null when malformed. */
function parseWorkflowRunPath(pathname: string): { workflowId: string; runId: string } | null {
  const segments = pathname.replace(/^\/api\/workflows\//, "").split("/");
  if (segments.length !== 3 || segments[1] !== "runs") return null;
  try {
    const workflowId = decodeURIComponent(segments[0]);
    const runId = decodeURIComponent(segments[2]);
    return workflowId === "" || runId === "" ? null : { workflowId, runId };
  } catch {
    return null;
  }
}

/** Write a live JSON response with `Cache-Control: no-store` (this reads mutable run state). */
function writeLiveJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * `/api/workflows/:workflowId/runs/:runId` — the LIVE generic per-run projection route.
 * A malformed path is a JSON 404; a readable run (or a fail-visible run problem) is a
 * 200 body. Always `no-store`. The optional provider comes from construction-time DI.
 */
export async function handleApiWorkflowRun(
  res: ServerResponse, pathname: string, root: string,
  provider?: LiveStageProjectionProvider, timeoutMs?: number,
): Promise<void> {
  const ids = parseWorkflowRunPath(pathname);
  if (ids === null) {
    writeLiveJson(res, 404, { error: { code: "not_found", message: `bad workflow-run path: ${pathname}` } });
    return;
  }
  writeLiveJson(res, 200, await buildWorkflowRunProjection(root, ids.workflowId, ids.runId, provider, timeoutMs));
}
