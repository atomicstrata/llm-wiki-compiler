/**
 * @file Reconcile a lifecycle output whose durable intent survived a crash.
 * The intent was written under the lock after subject verification; only that
 * exact stage operation can settle an already-landed transition.
 */
import type { WorkflowExecutionContext } from "./execution-context.js";
import { runWriter } from "./execution-context.js";
import { createHash } from "node:crypto";
import { canonicalDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { allowedEvidence } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { StageOutputPendingError } from "./errors.js";
import { recordSettledStageOutput, type SubmitResult } from "./stage-output-internals.js";
import type { WorkflowRun, PendingStageOutput } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowStageDef, EntityTypeDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LifecycleStageOutput } from "./stage-output.js";

/** Hash exactly the bytes the lifecycle writer will put on disk. */
function bytesDigest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Bind only applied fields; undeclared evidence was always ignored by the writer. */
function lifecycleRequestDigest(def: EntityTypeDef, output: LifecycleStageOutput): string {
  return canonicalDigest({
    kind: output.kind, entityType: output.entityType, slug: output.slug,
    toState: output.toState, evidence: allowedEvidence(def, output.toState, output.evidence),
  });
}

/** Retain recovery of already-written internal intents using the former digest. */
function requestMatches(digest: string, def: EntityTypeDef, output: LifecycleStageOutput): boolean {
  if (digest === lifecycleRequestDigest(def, output)) return true;
  try { return digest === canonicalDigest(output); } catch { return false; }
}

/** Bind the request and predicted postimage while subject and page share a lock. */
export async function prepareLifecycleIntent(root: string, output: LifecycleStageOutput,
  context: WorkflowExecutionContext): Promise<NonNullable<PendingStageOutput["lifecycle"]>> {
  const preview = await context.host.domain.previewLifecycle(context.transaction, root, output);
  if (preview.decision !== "allow" && preview.decision !== "allow-with-warning") throw new Error("lifecycle intent is not applicable");
  const loaded = await context.host.profiles.load(root);
  const def = loaded.profile.entities[output.entityType]!;
  return { requestDigest: lifecycleRequestDigest(def, output), postimageDigest: bytesDigest(preview.body), decision: preview.decision };
}

/** Settle a landed write, or return null so the original subject is rechecked. */
export async function recoverLifecycleOutput(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, output: LifecycleStageOutput,
  context: WorkflowExecutionContext,
): Promise<SubmitResult | null> {
  const pending = run.pendingOutput;
  if (pending === undefined) return null;
  if (pending.stageId !== stage.id || pending.opId !== `${run.runId}:${stage.id}:${run.stateVersion}`
    || pending.lifecycle === undefined
    || !stage.writes.includes(output.entityType)) throw new StageOutputPendingError(run.runId, stage.id, pending.opId);
  const loaded = await context.host.profiles.load(root);
  const def = loaded.profile.entities[output.entityType];
  if (def?.lifecycle === undefined) throw new StageOutputPendingError(run.runId, stage.id, pending.opId);
  if (!requestMatches(pending.lifecycle.requestDigest, def, output)) throw new StageOutputPendingError(run.runId, stage.id, pending.opId);
  const read = await context.host.observations.entityFrontmatter(root, def, output.slug);
  if (read.kind !== "frontmatter") throw new StageOutputPendingError(run.runId, stage.id, pending.opId);
  if (read.meta[def.lifecycle.field] !== output.toState) return null;
  const digest = await context.host.observations.entityDigest(root, def, output.slug);
  if (digest === null || digest !== pending.lifecycle.postimageDigest) {
    throw new StageOutputPendingError(run.runId, stage.id, pending.opId);
  }
  const decision = pending.lifecycle.decision;
  const outputRef = { entityType: output.entityType, slug: output.slug, toState: output.toState, decision };
  const recorded = await recordSettledStageOutput(root, run, stage, outputRef, decision,
    runWriter(context));
  return { run: recorded, applied: true, decision };
}
