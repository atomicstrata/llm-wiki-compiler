/**
 * @file src/local-workflows/approval-subject.ts
 * @description Revalidates a core-minted verifier receipt into the exact digest
 * a human gate may approve. This path is product-neutral and loads no product
 * code: it checks retained artifacts, live targets, run authority, and chain root.
 */

import { canonicalDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { parseArtifactRef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { resolveProcessVerifierPin } from "./process-definition.js";
import { predecessorChainRoot } from "./verifier-receipt.js";
import type { SubjectGateDescriptorV1 } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { VerifierReceiptV1, WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** A subject receipt is absent, malformed, stale, or no longer healthy. */
export class SubjectGateVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`subject-bound gate refused: ${reason}`);
    this.name = "SubjectGateVerificationError";
  }
}

/** Assert the receipt still names this exact run and immutable authority. */
function assertRunBindings(run: WorkflowRun, receipt: VerifierReceiptV1): void {
  const authority = run.processAuthority;
  if (authority === undefined) throw new SubjectGateVerificationError("process-authority-missing");
  const same = receipt.runId === run.runId && receipt.workflowId === run.workflowId
    && receipt.workflowDigest === run.workflowDigest && receipt.profileDigest === run.profileDigest
    && receipt.processDefinitionDigest === authority.processDefinitionDigest
    && receipt.workspaceId === authority.workspaceId
    && receipt.workspaceCompositionDigest === authority.workspaceCompositionDigest;
  if (!same) throw new SubjectGateVerificationError("receipt-authority-drift");
}

/** Assert the raw and additional retained artifacts remain healthy. */
async function assertArtifacts(host: LocalWorkflowHost, root: string, receipt: VerifierReceiptV1): Promise<void> {
  const profile = (await host.profiles.load(root)).profile;
  for (const raw of [receipt.rawArtifactRef, ...receipt.boundArtifactRefs]) {
    const ref = parseArtifactRef(raw);
    if (ref === null || (await host.observations.artifact(root, profile, ref)).health !== "ok") {
      throw new SubjectGateVerificationError("artifact-drift");
    }
  }
}

/** Assert every exact live page target still hashes to the receipt's digest. */
async function assertLiveTargets(host: LocalWorkflowHost, root: string, receipt: VerifierReceiptV1): Promise<void> {
  for (const expected of receipt.liveTargets) {
    let current;
    try {
      current = await host.observations.liveTarget(root, expected.pageId);
    } catch {
      throw new SubjectGateVerificationError("live-target-drift");
    }
    if (current.contentDigest !== expected.contentDigest) {
      throw new SubjectGateVerificationError("live-target-drift");
    }
  }
}

/** Reverify one subject-gate receipt and return the digest shown and approved. */
export async function verifyApprovalSubject(
  root: string, run: WorkflowRun, stageId: string, gateId: string,
  declaration: SubjectGateDescriptorV1,
  host: LocalWorkflowHost,
): Promise<string> {
  const receipt = run.verifierReceipts?.[declaration.outputStageId];
  if (receipt === undefined) throw new SubjectGateVerificationError("receipt-missing");
  if (receipt.outputStageId !== declaration.outputStageId
    || receipt.verifierId !== declaration.verifierId) {
    throw new SubjectGateVerificationError("receipt-contract-mismatch");
  }
  const raw = parseArtifactRef(receipt.rawArtifactRef);
  if (raw?.artifactType !== declaration.artifactType) {
    throw new SubjectGateVerificationError("receipt-contract-mismatch");
  }
  assertRunBindings(run, receipt);
  const pin = await resolveProcessVerifierPin(root, run, declaration.verifierId, host.observations.processSource);
  if (pin.implementationDigest !== receipt.verifierImplementationDigest) {
    throw new SubjectGateVerificationError("verifier-implementation-drift");
  }
  if (canonicalDigest(receipt.normalizedEnvelope) !== receipt.normalizedEnvelopeDigest
    || predecessorChainRoot(run, declaration.outputStageId) !== receipt.predecessorChainRoot) {
    throw new SubjectGateVerificationError("receipt-digest-drift");
  }
  await assertArtifacts(host, root, receipt);
  await assertLiveTargets(host, root, receipt);
  return canonicalDigest({ schemaVersion: 1, stageId, gateId, receipt });
}
