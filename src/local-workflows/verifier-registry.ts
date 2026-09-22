/**
 * @file src/local-workflows/verifier-registry.ts
 * @description Defines the immutable host-verifier registry used to admit
 * product evidence. Registries contain code selected by the host build, while
 * process definitions may only pin an id and exact implementation digest.
 */

import { canonicalDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { WorkflowVerifierError } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
export { WorkflowVerifierError } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Evidence a pinned verifier may inspect; artifact bytes are already healthy. */
export interface HostVerifierInputV1 {
  root: string;
  run: WorkflowRun;
  outputStageId: string;
  rawArtifactRef: string;
  rawArtifactBytes: Buffer;
}

/** Accepted evidence projected into generic, receipt-bound values. */
export interface HostVerifierAcceptedV1 {
  kind: "accepted";
  normalizedEnvelope: unknown;
  boundValues: Record<string, string>;
  liveTargetPageIds?: string[];
  boundArtifactRefs?: string[];
}

/** A stable rejection from the pinned verifier. */
export interface HostVerifierRejectedV1 {
  kind: "rejected";
  reasonCode: string;
}

/** One host-owned verifier implementation. */
export interface HostVerifierImplementationV1 {
  verifierId: string;
  implementationDigest: string;
  verify(input: HostVerifierInputV1): Promise<HostVerifierAcceptedV1 | HostVerifierRejectedV1>;
}

/** Immutable lookup surface; there is no runtime registration method. */
export interface HostVerifierRegistryV1 {
  resolve(verifierId: string, implementationDigest: string): HostVerifierImplementationV1;
}

/** Derive the digest a process definition pins for a host verifier revision. */
export function verifierImplementationDigest(verifierId: string, revision: string): string {
  return canonicalDigest({ schemaVersion: 1, verifierId, revision });
}

/** Build a closed, duplicate-free registry from host-selected implementations. */
export function createVerifierRegistry(
  implementations: readonly HostVerifierImplementationV1[],
): HostVerifierRegistryV1 {
  const byId = new Map<string, HostVerifierImplementationV1>();
  for (const implementation of implementations) {
    if (byId.has(implementation.verifierId)) throw new WorkflowVerifierError("duplicate-verifier-id");
    byId.set(implementation.verifierId, Object.freeze(implementation));
  }
  return Object.freeze({
    resolve(verifierId: string, implementationDigest: string) {
      const implementation = byId.get(verifierId);
      if (implementation === undefined) throw new WorkflowVerifierError("verifier-not-registered");
      if (implementation.implementationDigest !== implementationDigest) {
        throw new WorkflowVerifierError("verifier-implementation-drift");
      }
      return implementation;
    },
  });
}
