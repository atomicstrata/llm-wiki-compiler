/**
 * Source compatibility exports for optional local workflow verification.
 * Implementations share identities with the host-constructed engine.
 */
export { predecessorChainRoot, mintVerifierReceiptWithHost } from "@atomicstrata/llmwiki-local-workflows";
export { readLiveTargetDigest } from "@atomicstrata/llmwiki-core";
import { mintVerifierReceiptWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { HostVerifierRegistryV1 } from "./verifier-registry.js";
import type { VerifierReceiptV1 } from "@atomicstrata/llmwiki-core/local-workflow-contracts";


/** Mint and persist one receipt under the producing stage id. */
export async function mintVerifierReceipt(
  root: string, runId: string, outputStageId: string, rawArtifactRef: string,
  verifierId: string, registry: HostVerifierRegistryV1,
): Promise<VerifierReceiptV1> {
  return mintVerifierReceiptWithHost(createLocalWorkflowHost(), root, runId, outputStageId, rawArtifactRef, verifierId, registry);
}
