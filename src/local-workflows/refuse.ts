/**
 * @file src/local-workflows/refuse.ts
 * @description Irreversibly settles an active product workflow as refused from
 * a terminal disposition declared by its digest-bound process definition. The
 * caller supplies evidence and a verifier result; core derives the reason.
 */

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { parseArtifactRef, formatArtifactRef, type ArtifactRef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { RunNotActiveError } from "./errors.js";
import { resolveTerminalDisposition } from "./process-definition.js";
import { commitTerminalEvent, isTerminalStatus, withHostRunLock } from "./with-lock.js";
import { terminalRunWriter, projectWithHost } from "./execution-context.js";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Inputs that select a declared disposition and its retained evidence. */
export interface RefuseWorkflowOptionsV1 {
  verifierResult: string;
  evidenceRef: ArtifactRef | string;
}

/** A refusal whose evidence is malformed, unhealthy, or out of authority. */
export class WorkflowRefusalError extends Error {
  constructor(readonly reason: string) {
    super(`workflow refusal is ${reason}`);
    this.name = "WorkflowRefusalError";
  }
}

/** Parse and verify the exact evidence artifact under the active profile. */
async function verifiedEvidenceRef(
  host: LocalWorkflowHost, root: string, supplied: ArtifactRef | string,
): Promise<string> {
  const ref = typeof supplied === "string" ? parseArtifactRef(supplied) : supplied;
  if (ref === null) throw new WorkflowRefusalError("malformed-evidence-ref");
  const compact = formatArtifactRef(ref);
  if (parseArtifactRef(compact) === null) throw new WorkflowRefusalError("malformed-evidence-ref");
  const { profile } = await host.profiles.load(root);
  if ((await host.observations.artifact(root, profile, ref)).health !== "ok") {
    throw new WorkflowRefusalError("evidence-not-verified");
  }
  return compact;
}

/** Mark the current stage completed without disturbing earlier stage history. */
function completeCurrentStage(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    stageLog: run.stageLog.map((entry) =>
      entry.stageId === run.currentStage ? { ...entry, status: "completed" } : entry),
  };
}

/** Refuse through core observations and persistence without moving disposition policy out of the engine. */
export async function refuseWorkflowWithHost(host: LocalWorkflowHost,
  root: string, runId: string, options: RefuseWorkflowOptionsV1): Promise<WorkflowRun> {
  const run = await withHostRunLock(host, root, runId, async (locked, context) => {
    if (isTerminalStatus(locked.status)) throw new RunNotActiveError(runId, locked.status);
    if (locked.processAuthority === undefined) throw new WorkflowRefusalError("process-authority-required");
    const disposition = await resolveTerminalDisposition(root, locked, options.verifierResult, host.observations.processSource);
    const evidenceRef = await verifiedEvidenceRef(host, root, options.evidenceRef);
    const refusedAt = new Date().toISOString();
    const refusal = {
      reasonCode: disposition.reasonCode,
      evidenceRef,
      refusedAt,
      predecessorStateVersion: locked.stateVersion,
      processDefinitionDigest: locked.processAuthority.processDefinitionDigest,
    };
    return commitTerminalEvent(root, completeCurrentStage(locked), {
      type: "run-refused", at: refusedAt, actorKind: "system",
      stageId: locked.currentStage ?? undefined, decision: disposition.reasonCode,
    }, { status: "refused", currentStage: null, refusal }, terminalRunWriter(context));
  });
  await projectWithHost(host, root, run);
  return run;
}
