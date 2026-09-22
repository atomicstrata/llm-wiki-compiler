/**
 * @file test/preparations/checkpoint.test.ts
 * @description Compatible/incompatible checkpoint lineage matrices (design
 * section 16.3). A checkpoint resumes ONLY when every recorded lineage digest
 * still equals the value recomputed from the current sealed attempt; a single
 * drifted dimension — provider pin, capability contract, invocation schema, input
 * exposure, or authority snapshot — refuses resume, as does a bad index, a broken
 * prior chain, or non-checkpoint evidence.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { sealAttemptContext } from "../../src/preparations/attempts/start.js";
import { buildCheckpointRef, checkpointDigest, classifyCheckpointResume } from "../../src/preparations/attempts/checkpoint.js";
import type { SealAuthorityExtrasV1 } from "../../src/preparations/attempts/types.js";
import type { EvidenceRefV1 } from "../../src/preparations/types.js";

const D = parseSha256Digest(`sha256:${"a".repeat(64)}`);
const OTHER = parseSha256Digest(`sha256:${"b".repeat(64)}`);

const manifest = () => ({
  planDigest: D, plan: {
    knowledgeAuthority: { digest: D }, operationsAuthority: { digest: D },
    actionAuthority: { actionDescriptorDigest: D, handlerContractDigest: D }, recipeDigest: D, safetyFloorDigest: D,
  },
}) as never;
const bounds = () => ({ maximumAttempts: 2, maximumInvocationsPerAttempt: 1, maximumBrokerRequestsPerAttempt: 0, maximumEffectsPerAttempt: 0, maximumTransitionsPerInstance: 4, maximumOutputEvidenceBytes: 1024, maximumCheckpointBytes: 64, maximumTokensPerAttempt: 0, maximumTimeMsPerInstance: 1000, maximumCostMicrosPerAttempt: 0 }) as never;

function seal(extras: SealAuthorityExtrasV1) {
  return sealAttemptContext({
    manifest: manifest(), executor: { kind: "provider-capability", providerPinDigest: D, capabilityId: "c", capabilityContractDigest: D } as never,
    bounds: bounds(), extras, attemptId: `pat_${"a".repeat(64)}` as never, phaseInstanceId: `phi_${"a".repeat(64)}` as never,
    logicalPhaseId: "collect", disposition: "required", lease: { pid: 1, leaseNonce: "n", acquiredAt: "t" }, stateVersionAtSeal: 1,
  });
}

const providerExtras = (over: Partial<SealAuthorityExtrasV1> = {}): SealAuthorityExtrasV1 => ({ inputExposureSetDigest: D, providerPinDigest: D, ...over });
const checkpointEvidence = (): EvidenceRefV1 => ({
  kind: "provider-checkpoint", mediaType: "application/octet-stream", provenanceLabel: "cp", digest: D, byteCount: 10,
  sensitivity: "ordinary", retention: "checkpoint", producer: { kind: "provider", providerPinDigest: D, attemptId: `pat_${"a".repeat(64)}` }, untrusted: true,
});

describe("checkpoint resume lineage matrix", () => {
  it("resumes when every recorded lineage digest matches the sealed attempt", () => {
    const sealed = seal(providerExtras());
    const ref = buildCheckpointRef({ sealed, evidenceRef: checkpointEvidence(), checkpointIndex: 0 });
    expect(classifyCheckpointResume(sealed, ref)).toEqual({ kind: "resume" });
  });

  it("refuses resume when the input-exposure dimension drifted", () => {
    const ref = buildCheckpointRef({ sealed: seal(providerExtras()), evidenceRef: checkpointEvidence(), checkpointIndex: 0 });
    const drifted = seal(providerExtras({ inputExposureSetDigest: OTHER }));
    expect(classifyCheckpointResume(drifted, ref)).toEqual({ kind: "incompatible", reason: "checkpoint-input-exposure-drift" });
  });

  it("refuses resume when the provider pin drifted", () => {
    const ref = buildCheckpointRef({ sealed: seal(providerExtras()), evidenceRef: checkpointEvidence(), checkpointIndex: 0 });
    const drifted = seal(providerExtras({ providerPinDigest: OTHER }));
    expect(classifyCheckpointResume(drifted, ref).kind).toBe("incompatible");
  });

  it("refuses resume when the prior-checkpoint chain is broken", () => {
    const sealed = seal(providerExtras());
    const ref = { ...buildCheckpointRef({ sealed, evidenceRef: checkpointEvidence(), checkpointIndex: 0 }), checkpointIndex: 2 };
    expect(classifyCheckpointResume(sealed, ref)).toEqual({ kind: "incompatible", reason: "checkpoint-chain-broken" });
  });

  it("refuses resume when the evidence is not checkpoint-retention bytes", () => {
    const sealed = seal(providerExtras());
    const ref = { ...buildCheckpointRef({ sealed, evidenceRef: checkpointEvidence(), checkpointIndex: 0 }), evidenceRef: { ...checkpointEvidence(), retention: "audit" as const } };
    expect(classifyCheckpointResume(sealed, ref)).toEqual({ kind: "incompatible", reason: "checkpoint-evidence-invalid" });
  });
});

describe("checkpoint construction and chaining", () => {
  it("rejects a non-provider or pin-less sealed lineage", () => {
    expect(() => buildCheckpointRef({ sealed: seal({ inputExposureSetDigest: D }), evidenceRef: checkpointEvidence(), checkpointIndex: 0 }))
      .toThrow(/provider pin/);
  });

  it("rejects an index/prior chaining disagreement at construction", () => {
    const sealed = seal(providerExtras());
    expect(() => buildCheckpointRef({ sealed, evidenceRef: checkpointEvidence(), checkpointIndex: 1 })).toThrow(/chaining disagree/);
  });

  it("chains a successor to a prior checkpoint digest deterministically", () => {
    const sealed = seal(providerExtras());
    const first = buildCheckpointRef({ sealed, evidenceRef: checkpointEvidence(), checkpointIndex: 0 });
    const second = buildCheckpointRef({ sealed, evidenceRef: checkpointEvidence(), checkpointIndex: 1, priorCheckpointDigest: checkpointDigest(first) });
    expect(second.priorCheckpointDigest).toBe(checkpointDigest(first));
    expect(classifyCheckpointResume(sealed, second)).toEqual({ kind: "resume" });
  });
});
