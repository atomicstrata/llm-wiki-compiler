/**
 * @file src/local-workflows/human-input.ts
 * @description Immutable settlement for a declarative human-input workflow
 * stage. Core admits the captured payload against active profile authority,
 * derives every envelope field itself, and makes exact replay idempotent while
 * refusing any divergent second submission.
 */

import { canonicalDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { currentActorIdentity } from "./actor-identity.js";
import { appendRunEvent } from "./events.js";
import { HumanInputValidationError, admitHumanInput } from "./human-input-schema.js";
import type { HumanInputDescriptorV1 } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { SubmitResult } from "./stage-output-internals.js";
import type { WorkflowExecutionContext } from "./execution-context.js";
import { runWriter } from "./execution-context.js";

/** The only caller-controlled part of a human-input stage submission. */
export interface HumanInputStageOutput {
  kind: "human-input";
  input: Record<string, unknown>;
}

/** Core-derived immutable reference stored under the stage id. */
export interface HumanInputRefV1 extends Record<string, unknown> {
  schemaVersion: 1;
  kind: "human-input-ref";
  schemaId: string;
  payloadDigest: string;
  payload: Record<string, unknown>;
  submittedBy: string;
  submittedAt: string;
  runId: string;
  workflowId: string;
  profileDigest: string;
  predecessorOutputDigest: string;
  processDefinitionDigest?: string;
  workspaceId?: string;
}

/** Build the host-controlled envelope for one admitted payload. */
function buildRef(
  run: WorkflowRun, descriptor: HumanInputDescriptorV1, payload: Record<string, unknown>, submittedAt: string,
): HumanInputRefV1 {
  const process = run.processAuthority;
  return {
    schemaVersion: 1, kind: "human-input-ref", schemaId: descriptor.schemaId,
    payloadDigest: canonicalDigest(payload), payload,
    submittedBy: currentActorIdentity(), submittedAt,
    runId: run.runId, workflowId: run.workflowId, profileDigest: run.profileDigest,
    predecessorOutputDigest: canonicalDigest(run.outputs),
    ...(process === undefined ? {} : {
      processDefinitionDigest: process.processDefinitionDigest,
      workspaceId: process.workspaceId,
    }),
  };
}

/** Return an exact prior settlement, or refuse a divergent replay. */
function replayResult(run: WorkflowRun, stageId: string, candidate: HumanInputRefV1): SubmitResult | undefined {
  const prior = run.outputs[stageId] as Partial<HumanInputRefV1> | undefined;
  if (prior === undefined) return undefined;
  if (prior.kind === "human-input-ref" && prior.schemaId === candidate.schemaId
    && prior.payloadDigest === candidate.payloadDigest) {
    return { run, applied: true, decision: "accepted" };
  }
  throw new HumanInputValidationError(stageId, "stage output is already settled with different input");
}

/** Admit and persist one human-input output while the caller holds the project lock. */
export async function recordHumanInputLocked(
  root: string, run: WorkflowRun, stageId: string, descriptor: HumanInputDescriptorV1, input: Record<string, unknown>,
  context: WorkflowExecutionContext,
): Promise<SubmitResult> {
  const profile = (await context.host.profiles.load(root)).profile;
  const payload = await admitHumanInput(root, profile, run, descriptor, input, context.host.observations);
  const submittedAt = new Date().toISOString();
  const ref = buildRef(run, descriptor, payload, submittedAt);
  const replay = replayResult(run, stageId, ref);
  if (replay !== undefined) return replay;
  const bumped = appendRunEvent(run, {
    type: "stage-output", at: submittedAt, actorKind: "human",
    actorLabel: ref.submittedBy, stageId, decision: "accepted",
  });
  const recorded = { ...bumped, outputs: { ...bumped.outputs, [stageId]: ref } };
  await runWriter(context)(root, recorded);
  return { run: recorded, applied: true, decision: "accepted" };
}
