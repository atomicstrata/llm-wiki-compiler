/**
 * @file src/local-workflows/product-operation-output.ts
 * @description Authenticates an applied product-operation handoff and records a
 * core-stamped receipt that generic workflow advancement can later reverify.
 */
import { canonicalDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { preparationManifestDigest, type PreparationManifestV1 } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { PreparationRunV1 } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { recordSettledStageOutput, type SubmitResult } from "./stage-output-internals.js";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowStageDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowExecutionContext } from "./execution-context.js";
import { runWriter } from "./execution-context.js";

type ProductObservations = Pick<LocalWorkflowHost["observations"], "locatePreparation" | "readPreparation" | "operationBundle">;

/** Caller-held identity of an applied handoff; all other fields are core-derived. */
export interface ProductOperationStageOutput {
  readonly kind: "product-operation";
  readonly preparationRunId: string;
  readonly bundleManifestDigest: string;
}

/** Durable authority receipt written under the product-action stage. */
interface ProductOperationRefV1 {
  readonly schemaVersion: 1;
  readonly kind: "product-operation";
  readonly stageId: string;
  readonly actionId: string;
  readonly preparationRunId: string;
  readonly preparationId: string;
  readonly preparationManifestDigest: string;
  readonly preparationPlanDigest: string;
  readonly recipeDigest: string;
  readonly bundleManifestDigest: string;
  readonly evidenceDigests: readonly string[];
  readonly appliedTargets: readonly string[];
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly runId: string;
  readonly profileDigest: string;
  readonly processDefinitionDigest: string;
  readonly workspaceId: string;
  readonly workspaceCompositionDigest: string;
  readonly predecessorOutputDigest: string;
  readonly settledAt: string;
}

/** Core-stamped proof of a reviewed evidence-only product preparation. */
export interface ProductPreparationRefV1 {
  readonly schemaVersion: 1;
  readonly kind: "product-preparation";
  readonly stageId: string;
  readonly actionId: string;
  readonly preparationRunId: string;
  readonly preparationId: string;
  readonly preparationManifestDigest: string;
  readonly preparationPlanDigest: string;
  readonly recipeDigest: string;
  readonly evidenceDigests: readonly string[];
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly runId: string;
  readonly profileDigest: string;
  readonly processDefinitionDigest: string;
  readonly workspaceId: string;
  readonly workspaceCompositionDigest: string;
  readonly predecessorOutputDigest: string;
  readonly settledAt: string;
}

/** Fail with one stable product-operation settlement error. */
function refuse(detail: string): never {
  throw new Error(`product operation output is not authenticated: ${detail}`);
}

/** Compare the manifest's workflow graft with the active run and stage. */
function assertWorkflowParent(run: WorkflowRun, stage: WorkflowStageDef, parent: unknown): void {
  if (typeof parent !== "object" || parent === null) refuse("workflow parent is absent");
  const value = parent as Record<string, unknown>;
  const digest = run.workflowDigest.startsWith("sha256:") ? run.workflowDigest : `sha256:${run.workflowDigest}`;
  if (value.workflowRunId !== run.runId || value.workflowId !== run.workflowId
    || value.workflowDigest !== digest || value.stageId !== stage.id) {
    refuse("workflow parent does not match the active stage");
  }
}

/** Digest only outputs preceding this stage in the declared run order. */
function predecessorOutputDigest(run: WorkflowRun, stageId: string): string {
  const index = run.knownStageIds.indexOf(stageId);
  if (index < 0) refuse("stage is absent from the run authority");
  return canonicalDigest(run.knownStageIds.slice(0, index).map((id) => ({
    stageId: id, output: Object.hasOwn(run.outputs, id) ? run.outputs[id] : null,
  })));
}

/** Require an exact applied handoff and return its authenticated live targets. */
async function appliedTargets(root: string, expected: string, actual: string | undefined, observations: ProductObservations) {
  if (actual !== expected) refuse("preparation handoff does not match the submitted bundle");
  const observed = await observations.operationBundle(root, expected);
  if (observed.status !== "observed" || !observed.applied) refuse("bundle is not applied");
  return observed.appliedTargets;
}

/** Assemble the immutable receipt from already-authenticated values. */
function buildFacts(
  run: WorkflowRun, stage: WorkflowStageDef, output: ProductOperationStageOutput,
  manifest: PreparationManifestV1, preparation: PreparationRunV1, targets: readonly string[],
): Omit<ProductOperationRefV1, "settledAt"> {
  const process = run.processAuthority!;
  return {
    schemaVersion: 1, kind: "product-operation", stageId: stage.id, actionId: stage.productAction!,
    preparationRunId: output.preparationRunId, preparationId: manifest.preparationId,
    preparationManifestDigest: preparationManifestDigest(manifest), preparationPlanDigest: manifest.planDigest,
    recipeDigest: manifest.plan.recipeDigest, bundleManifestDigest: output.bundleManifestDigest,
    evidenceDigests: preparation.evidenceRefs.map((item) => item.digest), appliedTargets: [...targets],
    workflowId: run.workflowId, workflowDigest: run.workflowDigest, runId: run.runId,
    profileDigest: run.profileDigest, processDefinitionDigest: process.processDefinitionDigest,
    workspaceId: process.workspaceId, workspaceCompositionDigest: process.workspaceCompositionDigest,
    predecessorOutputDigest: predecessorOutputDigest(run, stage.id),
  };
}

/** Derive every authority-bearing receipt field from authenticated stores. */
async function operationFacts(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, output: ProductOperationStageOutput,
  observations: ProductObservations,
): Promise<Omit<ProductOperationRefV1, "settledAt">> {
  const authority = await verifiedPreparationAuthority(root, run, stage, output.preparationRunId, observations);
  const targets = await appliedTargets(root, output.bundleManifestDigest, authority.preparation.handoff?.bundleManifestDigest, observations);
  return buildFacts(run, stage, output, authority.manifest, authority.preparation, targets);
}

/** Authenticate one exact preparation against the active product-action stage. */
async function verifiedPreparationAuthority(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, preparationRunId: string,
  observations: ProductObservations,
) {
  const actionId = stage.productAction, process = run.processAuthority;
  if (actionId === undefined || process === undefined) refuse("product process authority is absent");
  const located = await observations.locatePreparation(root, preparationRunId);
  if (!located.ok) refuse(`preparation did not locate (${located.reason})`);
  const lookup = await observations.readPreparation(root, located.manifest);
  if (!lookup.ok) refuse(`preparation run did not verify (${lookup.reason})`);
  if (preparationManifestDigest(located.manifest) !== lookup.run.manifestDigest) refuse("manifest digest drifted");
  if (located.manifest.plan.actionAuthority.actionId !== actionId) refuse("manifest action differs");
  if (lookup.run.workspaceId !== process.workspaceId) refuse("workspace differs");
  assertWorkflowParent(run, stage, located.manifest.plan.workflowParent);
  return { manifest: located.manifest, preparation: lookup.run };
}

/** Mint an evidence-only proof after its reviewed preparation settled cleanly. */
export async function productPreparationRef(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, preparationRunId: string,
  observations: ProductObservations,
): Promise<ProductPreparationRefV1> {
  const { manifest, preparation } = await verifiedPreparationAuthority(root, run, stage, preparationRunId, observations);
  if (preparation.state !== "succeeded" || preparation.handoff !== undefined) {
    refuse("evidence-only preparation is not cleanly settled");
  }
  const process = run.processAuthority!;
  return {
    schemaVersion: 1, kind: "product-preparation", stageId: stage.id, actionId: stage.productAction!,
    preparationRunId, preparationId: manifest.preparationId,
    preparationManifestDigest: preparationManifestDigest(manifest), preparationPlanDigest: manifest.planDigest,
    recipeDigest: manifest.plan.recipeDigest, evidenceDigests: preparation.evidenceRefs.map((item) => item.digest),
    workflowId: run.workflowId, workflowDigest: run.workflowDigest, runId: run.runId,
    profileDigest: run.profileDigest, processDefinitionDigest: process.processDefinitionDigest,
    workspaceId: process.workspaceId, workspaceCompositionDigest: process.workspaceCompositionDigest,
    predecessorOutputDigest: predecessorOutputDigest(run, stage.id), settledAt: new Date().toISOString(),
  };
}

/** Reverify a stored evidence-only preparation proof without trusting its verdict. */
async function assertProductPreparationCurrent(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, stored: ProductPreparationRefV1,
  observations: ProductObservations,
): Promise<void> {
  if (stored.kind !== "product-preparation" || stored.schemaVersion !== 1
    || typeof stored.settledAt !== "string") refuse("stored preparation proof is malformed");
  const fresh = await productPreparationRef(root, run, stage, stored.preparationRunId, observations);
  const { settledAt: _old, ...oldFacts } = stored, { settledAt: _new, ...newFacts } = fresh;
  if (canonicalDigest(oldFacts) !== canonicalDigest(newFacts)) refuse("stored preparation proof drifted");
}

/** Reverify whichever product proof the stage output contains. */
export async function assertProductStageOutputCurrent(
  root: string, run: WorkflowRun, stage: WorkflowStageDef,
  observations: ProductObservations,
): Promise<void> {
  const output = run.outputs[stage.id] as Record<string, unknown> | undefined;
  if (output?.kind === "product-operation") return assertProductOperationOutputCurrent(root, run, stage, observations);
  const proof = output?.productPreparation;
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) refuse("product preparation proof is absent");
  return assertProductPreparationCurrent(root, run, stage, proof as unknown as ProductPreparationRefV1, observations);
}

/** Parse and compare a stored receipt against a fresh authenticated observation. */
export async function assertProductOperationOutputCurrent(
  root: string, run: WorkflowRun, stage: WorkflowStageDef,
  observations: ProductObservations,
): Promise<void> {
  const stored = run.outputs[stage.id] as Partial<ProductOperationRefV1> | undefined;
  if (stored?.kind !== "product-operation" || stored.schemaVersion !== 1
    || typeof stored.preparationRunId !== "string" || typeof stored.bundleManifestDigest !== "string"
    || typeof stored.settledAt !== "string") refuse("stored receipt is malformed");
  const { settledAt: _settledAt, ...recordedFacts } = stored;
  const fresh = await operationFacts(root, run, stage, {
    kind: "product-operation", preparationRunId: stored.preparationRunId,
    bundleManifestDigest: stored.bundleManifestDigest,
  }, observations);
  if (canonicalDigest(recordedFacts) !== canonicalDigest(fresh)) refuse("stored receipt drifted");
}

/** Record one verified product-operation result under the active stage. */
export async function recordProductOperationOutputLocked(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, output: ProductOperationStageOutput,
  context: WorkflowExecutionContext,
): Promise<SubmitResult> {
  const facts = await operationFacts(root, run, stage, output, context.host.observations);
  const ref: ProductOperationRefV1 = { ...facts, settledAt: new Date().toISOString() };
  return { run: await recordSettledStageOutput(root, run, stage, { ...ref }, "accepted",
    runWriter(context)), applied: true, decision: "accepted" };
}

/** Reverify an exact retry without writing or applying a second time. */
export async function replayProductOperationOutputLocked(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, output: ProductOperationStageOutput,
  observations: ProductObservations,
): Promise<SubmitResult> {
  const stored = run.outputs[stage.id] as Partial<ProductOperationRefV1>;
  if (stored.preparationRunId !== output.preparationRunId
    || stored.bundleManifestDigest !== output.bundleManifestDigest) refuse("replay differs from recorded receipt");
  await assertProductOperationOutputCurrent(root, run, stage, observations);
  return { run, applied: true, decision: "accepted" };
}
