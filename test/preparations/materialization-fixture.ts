/**
 * @file test/preparations/materialization-fixture.ts
 * @description Shared materialization fixtures for the finalization and runner
 * suites: one zero-deficit completeness record over a single fully-included
 * class, one referenced payload, and the data-only result a well-behaved
 * materializer returns. Extracted so the two suites cannot drift on what a
 * valid materialization looks like.
 */

import { createHash } from "node:crypto";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { deriveCompleteness } from "../../src/preparations/completeness.js";
import type { EvidenceRefV1 } from "../../src/preparations/types.js";

export const FIXTURE_PAYLOAD = Buffer.from(JSON.stringify({ draft: "proposal-a" }));
export const FIXTURE_PAYLOAD_DIGEST = createHash("sha256").update(FIXTURE_PAYLOAD).digest("hex");

/** The shared completeness identity-set evidence reference used across fixtures. */
export const COMPLETENESS_IDENTITY_REF: EvidenceRefV1 = {
  kind: "completeness-identity-set", mediaType: "application/json", provenanceLabel: "host-derived",
  digest: parseSha256Digest(`sha256:${"a".repeat(64)}`), byteCount: 128, sensitivity: "ordinary", retention: "audit",
  producer: { kind: "host", contractDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`) }, untrusted: true,
};
const IDENTITY_REF = COMPLETENESS_IDENTITY_REF;

/** A zero-deficit completeness record: one required class, fully included. */
export function fullCompleteness() {
  const one = {
    planned: ["a"], eligible: ["a"], attempted: ["a"], completed: ["a"], included: ["a"],
    skipped: [], unavailable: [], failed: [], cancelled: [], overflow: [], nonConverged: [],
  };
  return deriveCompleteness({ scopeId: "final", classes: [{
    classId: "outputs", disposition: "required", identitySetRef: IDENTITY_REF, identitySets: one,
  }] }).record;
}

/**
 * The data-only result a well-behaved materializer returns. When durable
 * evidence bytes are supplied, the payload IS those bytes — so the obligation
 * candidate provably depends on what the attempts persisted, and absent or
 * altered evidence changes (or refuses) the bundle. The no-argument form keeps
 * the finalization suite's direct fixtures working with the static payload.
 */
export function materializedResultCandidate(
  evidence?: ReadonlyMap<string, Buffer>,
): Record<string, unknown> {
  let payload: Buffer = FIXTURE_PAYLOAD;
  let digest = FIXTURE_PAYLOAD_DIGEST;
  if (evidence !== undefined) {
    const first = [...evidence.entries()][0];
    if (first === undefined) throw new Error("materializer requires durable evidence bytes");
    digest = first[0]; payload = first[1];
  }
  return {
    targets: [{ logicalIdentity: "docs/a", draft: { kind: "lifecycle-transition" } }],
    proposals: [], reconciliations: [], selections: [],
    completeness: fullCompleteness(),
    authorityInputs: [], authorityBounds: [],
    operationRun: { declaredCompensatorIndexes: [], controlTransitionAllowance: 1 },
    payloadRefs: [{ role: "proposal-payload", digest,
      byteCount: payload.byteLength, mediaType: "application/json" }],
  };
}

/** Declare (and fund) the materialization triple on one plan object. */
export function declareMaterializationCapacity(plan: Record<string, unknown>): void {
  const capacity = (plan.outputContract as Record<string, Record<string, number>>).handoffCapacity;
  Object.assign(capacity, {
    maximumMaterializationManifestBytes: 65_536,
    maximumMaterializationPayloadRefs: 4,
    maximumMaterializationPayloadBytes: 65_536,
  });
  const bounds = plan.bounds as Record<string, number>;
  bounds.maximumEvidenceRefs += 5;
  bounds.maximumEvidenceBytes += 131_072;
}
