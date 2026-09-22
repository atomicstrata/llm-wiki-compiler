/**
 * @file src/preparations/types.ts
 * @description Closed shared value objects referenced by the normalized
 * preparation plan (design sections 10.1, 11.3, 7.3, 17.2). These data-only
 * types expose no callbacks, executable adapters, or writable paths; every
 * digest reuses the repository's branded {@link Sha256Digest} rather than a
 * bare template-literal type so a mistyped hash cannot flow past the parser.
 */

import type { Sha256Digest } from "../capability-providers/types.js";

export type { Sha256Digest } from "../capability-providers/types.js";

/** The three closed evidence sensitivity classes. */
export type EvidenceSensitivity = "ordinary" | "private" | "restricted";

/**
 * A knowledge-profile or operations-pack authority binding: identity, exact
 * version, content digest, and installed template-independent runtime identity.
 */
export interface AuthorityRefV1 {
  id: string;
  version: string;
  digest: Sha256Digest;
  runtimeIdentityDigest: Sha256Digest;
}

/** The configured action authority and its effective capability ceiling. */
export interface ActionAuthorityRefV1 {
  actionId: string;
  actionDescriptorDigest: Sha256Digest;
  handlerContractDigest: Sha256Digest;
  requestedSurface: string;
  capabilityClassCeiling: string;
}

/** A one-way reference to an existing outer workflow run (design section 7.3). */
export interface WorkflowParentRefV1 {
  workflowRunId: string;
  workflowId: string;
  workflowDigest: Sha256Digest;
  stageId?: string;
}

/** The producer that authored one immutable evidence object. */
export type EvidenceProducerV1 =
  | { kind: "host"; contractDigest: Sha256Digest }
  | { kind: "provider"; providerPinDigest: Sha256Digest; attemptId: string }
  | { kind: "broker"; brokerId: string; requestId: string };

/**
 * A content-addressed reference to one immutable evidence object (design
 * section 11.3). Payload bytes are always untrusted; the marker is fixed true.
 */
export interface EvidenceRefV1 {
  kind: string;
  mediaType: string;
  provenanceLabel: string;
  digest: Sha256Digest;
  byteCount: number;
  sensitivity: EvidenceSensitivity;
  retention: "until-handoff" | "audit" | "checkpoint" | "terminal-only";
  producer: EvidenceProducerV1;
  untrusted: true;
}
