/**
 * @file src/local-workflows/subject-gate.ts
 * @description Small adapter between an optional stage subject-gate declaration
 * and approval-subject verification. Ordinary gates remain byte-compatible and
 * return no subject digest; declared subject gates always fail closed on drift.
 */

import { SubjectGateVerificationError, verifyApprovalSubject } from "./approval-subject.js";
import { parseGate } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowStageDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Resolve an optional verified subject digest for one current-stage gate. */
export async function subjectDigestForGate(
  root: string, run: WorkflowRun, stage: WorkflowStageDef, gateId: string,
  host: LocalWorkflowHost,
): Promise<string | undefined> {
  if (stage.subjectGate === undefined) return undefined;
  return verifyApprovalSubject(root, run, stage.id, gateId, stage.subjectGate, host);
}

/** Reverify that the recorded approval still covers the live subject. */
export async function assertApprovedSubjectCurrent(
  root: string, run: WorkflowRun, stage: WorkflowStageDef,
  host: LocalWorkflowHost,
): Promise<void> {
  if (stage.subjectGate === undefined) return;
  const gate = parseGate(stage.gate ?? "");
  if (gate === null) throw new SubjectGateVerificationError("subject-gate-missing");
  const current = await verifyApprovalSubject(root, run, stage.id, gate.id, stage.subjectGate, host);
  const approval = [...run.events].reverse().find((event) =>
    event.type === "gate-approved" && event.stageId === stage.id && event.gateId === gate.id);
  if (approval?.subjectDigest !== current) {
    throw new SubjectGateVerificationError("approval-subject-drift");
  }
}
