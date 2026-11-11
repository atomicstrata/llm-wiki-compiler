/**
 * Typed client for the viewer's workflow and artifact routes.
 *
 * Workflow runs live outside the frozen snapshot, so every fetch here reads
 * at request time. The run view and the artifact routes answer on loopback
 * only; elsewhere the server refuses them and the refusal is shown as is.
 */
import { getJson } from "./api";

/** How a run relates to the active profile configuration. */
export type RunClassification = "current" | "historical" | "needs-adaptation" | "blocked-by-config";

/** One row of `/api/workflow-runs`; a store problem is a row too, with `problem` set. */
export interface WorkflowRunRow {
  runId: string;
  classification: RunClassification;
  status?: string;
  currentStage?: string | null;
  workflow?: string;
  problem?: string;
  awaitingGate?: string;
  awaitingTrustGate?: true;
  awaitingOutput?: true;
  nextSubmitEntityType?: string;
  nextSubmitArtifactType?: string;
}

/** The run list. */
export interface WorkflowRunsEnvelope {
  runs: WorkflowRunRow[];
  workflowJourneys?: true;
}

/** A pinned artifact: type, slug and content hash. */
export interface ArtifactPin {
  artifactType: string;
  slug: string;
  sha256: string;
}

/** The gate guarding a stage and where its approval stands. */
export interface StageGate {
  gateId: string;
  gateKind: "human" | "agent" | "trust";
  state: "not-reached" | "awaiting" | "approved";
  decision?: string;
  actor?: string;
  actorKind?: string;
  at?: string;
  subjectDigest?: string;
}

/** One row of a verified stage's fact panel. */
export interface FactRow {
  label: string;
  value: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

interface StageBase {
  stageId: string;
  status: string;
  gate?: StageGate;
  outputRef?: ArtifactPin;
}

/** A stage known only from the run log; nothing about it has been re-verified. */
export interface RecordedStage extends StageBase {
  verification: "recorded-only";
  verificationReason?: { category: "stale-or-invalid" | "unavailable" | "timed-out"; code: string };
}

/** A stage a live provider verified, with what it found. */
export interface VerifiedStage extends StageBase {
  verification: "verified";
  summary: string;
  appliedTargets: string[];
  evidenceDigests: string[];
  groundedRefs?: string[];
  pdfRef?: ArtifactPin & { member: string };
  factPanel?: { title: string; rows: FactRow[] };
}

export type StageProjection = RecordedStage | VerifiedStage;

/** Why a live provider's verification is not what is shown. */
export type LiveOutcome =
  | { outcome: "applied" }
  | { outcome: "timed-out"; timeoutMs: number }
  | { outcome: "degraded" }
  | { outcome: "drifted" };

/** One run's stages, as projected by `/api/workflows/:workflowId/runs/:runId`. */
export interface WorkflowRunProjection {
  workflowId: string;
  runId: string;
  classification: RunClassification;
  generatedAt: string;
  stages: StageProjection[];
  live?: LiveOutcome;
}

/** The server could not project the run; it says why. */
export interface WorkflowRunProblem {
  workflowId: string;
  runId: string;
  problem: string;
}

export type WorkflowRunResponse = WorkflowRunProjection | WorkflowRunProblem;

/** What `/api/artifact` knows about one pinned artifact. */
export interface ArtifactMetadata {
  ref: string;
  health: string;
  manifest?: { artifactType: string; slug: string; sha256: string; bytes: number; contentKind: "json" | "text"; writtenAt: string };
  contentAccess: "available" | "loopback-only";
  fileName?: string;
  metadata?: Record<string, unknown>;
}

const RUN_UNAVAILABLE = "Workflow records could not be verified. Reopen this run to retry.";

/** Every recorded run, read fresh on each call. */
export function fetchWorkflowRuns(): Promise<WorkflowRunsEnvelope> {
  return getJson("/api/workflow-runs");
}

/** The `/api/workflows/<workflowId>/runs/<runId>` prefix every run route shares. */
function runPath(workflowId: string, runId: string): string {
  return `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`;
}

/** One run's projection, or the server's problem with it. A failed read is a problem too. */
export async function fetchWorkflowRun(workflowId: string, runId: string): Promise<WorkflowRunResponse> {
  try {
    return await getJson<WorkflowRunResponse>(runPath(workflowId, runId));
  } catch {
    return { workflowId, runId, problem: RUN_UNAVAILABLE };
  }
}

/** URL of a stage's recorded output bytes. */
export function stageOutputUrl(workflowId: string, runId: string, stageId: string): string {
  return `${runPath(workflowId, runId)}/stage/${encodeURIComponent(stageId)}/output`;
}

/** URL of a run's final PDF. */
export function runPdfUrl(workflowId: string, runId: string): string {
  return `${runPath(workflowId, runId)}/pdf`;
}

/** The `<type>/<slug>@sha256:<hex>` form the artifact routes take. */
export function artifactRef(pin: ArtifactPin): string {
  return `${pin.artifactType}/${pin.slug}@sha256:${pin.sha256}`;
}

/** Metadata of one artifact, re-checked against the store on every call. */
export function fetchArtifact(ref: string): Promise<ArtifactMetadata> {
  return getJson(`/api/artifact?ref=${encodeURIComponent(ref)}`);
}

/** URL that downloads an artifact's bytes as a file. */
export function artifactDownloadUrl(ref: string): string {
  return `/api/artifact/content?ref=${encodeURIComponent(ref)}&download=1`;
}
