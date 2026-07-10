/**
 * @file src/workflows/artifact-output.ts
 * @description The `artifact` arm of the stage-output seam — split out of
 * `stage-output.ts` (which reached its file-size budget) so the artifact-specific
 * types, scope guard, M2 immutability guard, and apply path live together.
 *
 * The arm is scope-gated on the stage's `artifactWrites`, refuses a trust-gated
 * write without the out-of-band operator grant (like relation/lifecycle — artifacts
 * have no staged-review path), and enforces M2 immutability
 * ({@link assertArtifactImmutable}) BEFORE routing the write through the executor's
 * under-lock artifact authority. It reuses the atomicity + trust-gate primitives
 * from `stage-output-internals.ts` ({@link preflightApplyRecord},
 * {@link guardTrustGatedNonPageWrite}, {@link WORST_CASE_DECISION}) — shared with the
 * page/relation/lifecycle arms with NO import cycle between the two arm modules — so
 * the pre-validate → apply → record discipline is identical across every kind.
 */

import { applyApprovedMutationsLocked } from "../trust/executor.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { artifactPaths, readArtifactManifest, hashArtifactBody } from "../artifacts/store.js";
import { StageWriteScopeError, WorkflowArtifactChangedError, WorkflowArtifactUnverifiableError } from "./errors.js";
import {
  preflightApplyRecord,
  guardTrustGatedNonPageWrite,
  WORST_CASE_DECISION,
  type SubmitResult,
} from "./stage-output-internals.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import type { BlockingLockOptions } from "../utils/lock.js";
import type { TrustDecision } from "../trust/decision.js";
import type { WorkflowRun } from "./types.js";
import type { WorkflowStageDef } from "../profile/types.js";

/** An artifact output: write `body` as the typed artifact `artifactType/slug`. */
export interface ArtifactStageOutput {
  kind: "artifact";
  artifactType: string;
  slug: string;
  body: string;
}

/**
 * The harness-stamped provenance for a WORKFLOW-produced artifact (never
 * caller-supplied): a plain workflow submit vs an MCP-triggered workflow action,
 * attributed distinctly. It is a subset of {@link ArtifactOrigin} so the arm can
 * NEVER stamp a `cli`/`sdk` origin, and — being set from a harness parameter, not
 * the output payload — an adversary cannot smuggle it through a stage output.
 */
export type WorkflowArtifactOrigin = "workflow" | "workflow-mcp";

/** Options for `submitStageOutput`: the harness-stamped artifact origin + lock overrides. */
export interface SubmitStageOutputOptions {
  /** The artifact origin the harness stamps (default `"workflow"`; the MCP action path passes `"workflow-mcp"`). */
  origin?: WorkflowArtifactOrigin;
  /** Bounded-blocking-lock overrides. */
  lockOptions?: BlockingLockOptions;
}

/**
 * THE artifact scope primitive: refuse `artifactType` unless it is in the stage's
 * `artifactWrites`, BEFORE any planning or I/O. A stage produces only the artifact
 * types it declares; an out-of-scope (or undeclared-scope) type fails closed with
 * {@link StageWriteScopeError} and the run is left byte-unchanged.
 */
function requireArtifactInScope(runId: string, stage: WorkflowStageDef, artifactType: string): void {
  if (!(stage.artifactWrites ?? []).includes(artifactType)) {
    throw new StageWriteScopeError(runId, stage.id, artifactType);
  }
}

/** A worst-case sha256 placeholder (exactly 64 hex chars — same width as a real one). */
const WORST_CASE_SHA256 = "0".repeat(64);

/**
 * M2 immutability guard, run UNDER the held lock BEFORE the artifact apply. Reads any
 * existing manifest for `(artifactType, slug)` and separates "doesn't qualify" from
 * "couldn't verify" (park-vs-deny at the read leg):
 * - `absent` → no prior artifact to protect (proceed; first write — the executor governs it).
 * - `ok` → the produced bytes MUST hash-match the stored sha256, else REFUSE
 *   ({@link WorkflowArtifactChangedError}); a byte-match falls through and the executor's
 *   applied-once short-circuit no-ops it.
 * - `unavailable`/`malformed` → immutability CANNOT be verified. Proceeding would let a
 *   divergent re-run silently overwrite pinned bytes (the executor's applied-once check
 *   also fails false here, and a malformed regular file slips past its lstat), so FAIL
 *   CLOSED ({@link WorkflowArtifactUnverifiableError}) with the on-disk artifact intact.
 */
async function assertArtifactImmutable(root: string, output: ArtifactStageOutput): Promise<void> {
  const loaded = await loadNonDefaultProfile(root);
  const def = loaded?.profile.artifacts?.[output.artifactType];
  if (!def) return; // undeclared type: the planner denies it downstream — nothing to protect here
  const paths = artifactPaths(root, output.artifactType, output.slug, def.fileName);
  const existing = await readArtifactManifest(root, paths);
  if (existing.kind === "absent") return; // no prior artifact — first write
  if (existing.kind !== "ok") {
    throw new WorkflowArtifactUnverifiableError(output.artifactType, output.slug, existing.kind);
  }
  if (existing.manifest.sha256 !== hashArtifactBody(output.body)) {
    throw new WorkflowArtifactChangedError(output.artifactType, output.slug, existing.manifest.sha256);
  }
}

/**
 * Handle an `artifact` output: SCOPE-GUARD the `artifactType` (must be in
 * `artifactWrites`), refuse a trust-gated write without the grant (like
 * relation/lifecycle — artifacts have no staged-review path), then route a single
 * {@link ArtifactPlannedMutation} through the executor's under-lock artifact
 * authority — which composes the real decision, gates on the operator grant, and
 * applies (or THROWS a refusal/denial). The origin is harness-stamped from `origin`
 * (never caller input). On success records the hash-pinned ref + real decision.
 *
 * M2 (immutable-once-written): {@link assertArtifactImmutable} runs BEFORE the apply —
 * a re-run producing byte-identical bytes falls through to the executor's applied-once
 * no-op (same stable sha256), a DIVERGENT re-run is REFUSED
 * ({@link WorkflowArtifactChangedError}) with the on-disk artifact left byte-unchanged.
 */
export async function applyArtifactOutput(
  root: string, runId: string, run: WorkflowRun, stage: WorkflowStageDef,
  output: ArtifactStageOutput, projectId: string, origin: WorkflowArtifactOrigin,
): Promise<SubmitResult> {
  requireArtifactInScope(runId, stage, output.artifactType);
  guardTrustGatedNonPageWrite(runId, stage, projectId, "artifact");
  await assertArtifactImmutable(root, output); // M2: never overwrite already-written bytes through the workflow arm
  const mutation: ArtifactPlannedMutation = { kind: "artifact", artifactType: output.artifactType, slug: output.slug, body: output.body, origin };
  const base = { artifactType: output.artifactType, slug: output.slug };
  let decision: TrustDecision = "allow";
  const recorded = await preflightApplyRecord(root, run, stage, { ...base, sha256: WORST_CASE_SHA256, decision: WORST_CASE_DECISION }, async () => {
    const [result] = await applyApprovedMutationsLocked(root, [mutation]);
    if (result?.kind !== "artifact") throw new Error("executor returned a non-artifact result for an artifact output");
    decision = result.decision;
    return { decision, outputRef: { ...base, sha256: result.ref.sha256, decision } };
  });
  return { run: recorded, applied: true, decision };
}
