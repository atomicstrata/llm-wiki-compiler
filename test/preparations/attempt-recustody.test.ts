/**
 * @file test/preparations/attempt-recustody.test.ts
 * @description Leg-H recustody contract (Global Constraint "providers and host
 * handlers produce evidence only"). A provider output is admitted only after its
 * bytes are COPIED and re-hashed through the preparation evidence store; the
 * committed run then owns those bytes. An output whose bytes do not hash to the
 * claimed digest, and a host-handler evidence ref not present in the store, both
 * fail closed to a failed phase with nothing recustodied.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPreparationEvidence, writePreparationEvidenceCreateOnly } from "../../src/preparations/evidence-store.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { providerLegRunner, type ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import { attemptRequest, driftingResolver, evidenceLocation, providerAuthority, providerRequest, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";
import type { ProviderInvocationHostV1 } from "../../src/capability-providers/runtime/invoke.js";

const HOST = {} as ProviderInvocationHostV1;
const BYTES = Buffer.from("recustody-output-bytes");
const HEX = createHash("sha256").update(BYTES).digest("hex");

let staged: StagedPreparation;
let custodyRoot: string;
beforeEach(async () => { staged = await stagePreparation(); custodyRoot = await mkdtemp(path.join(tmpdir(), "custody-")); });
afterEach(async () => { await staged.cleanup(); await rm(custodyRoot, { recursive: true, force: true }); });

/** A completed provider result whose one artifact carries a custody evidence path. */
function completedWithArtifact(evidencePath: string, claimedHex: string): ProviderInvokeFn {
  return async () => ({ kind: "completed", admitted: {
    outcome: "succeeded",
    acceptedArtifacts: [{ outputId: "report", mediaType: "application/json", digest: parseSha256Digest(`sha256:${claimedHex}`), byteCount: BYTES.byteLength,
      evidence: { evidencePath, digest: parseSha256Digest(`sha256:${claimedHex}`), byteCount: BYTES.byteLength } }],
    counts: { declared: 1, acceptedArtifacts: 1, requiredMissing: 0, receipts: 0 },
    receipts: [], usage: { brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved" },
    untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null } } });
}

function leg(invoke: ProviderInvokeFn) {
  return providerLegRunner({ request: providerRequest(), host: HOST, preparationRunId: staged.binding.runId }, invoke);
}

describe("preparation attempt recustody", () => {
  it("copies provider output bytes into the preparation evidence store before commit", async () => {
    const output = path.join(custodyRoot, "out.json");
    await writeFile(output, BYTES);
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: leg(completedWithArtifact(output, HEX)) }));
    expect(outcome.status === "committed" && outcome.phaseState).toBe("succeeded");
    expect((await readPreparationEvidence(staged.root, evidenceLocation(staged), HEX)).status).toBe("ok");
  });

  it("fails closed when the custody bytes do not hash to the claimed digest", async () => {
    const output = path.join(custodyRoot, "tampered.json");
    await writeFile(output, Buffer.from("different-bytes"));
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: leg(completedWithArtifact(output, HEX)) }));
    expect(outcome.status === "committed" && outcome.phaseState).toBe("failed");
    expect((await readPreparationEvidence(staged.root, evidenceLocation(staged), HEX)).status).toBe("absent");
  });

  it("durably parks and touches no pre-existing object when a batch cannot fully publish", async () => {
    const preexisting = Buffer.from("pre-existing-shared-object");
    const preHex = createHash("sha256").update(preexisting).digest("hex");
    await writePreparationEvidenceCreateOnly(staged.root, evidenceLocation(staged), preexisting);
    const valid = Buffer.from("valid-batch-object");
    const validHex = createHash("sha256").update(valid).digest("hex");
    await writeFile(path.join(custodyRoot, validHex), valid);
    const ref = (hex: string, byteCount: number) => ({
      kind: "provider-output", mediaType: "application/json", provenanceLabel: "p", digest: parseSha256Digest(`sha256:${hex}`),
      byteCount, sensitivity: "ordinary" as const, retention: "audit" as const,
      producer: { kind: "host" as const, contractDigest: parseSha256Digest(`sha256:${"2".repeat(64)}`) }, untrusted: true as const,
    });
    const pendingEvidence = [
      { ref: ref(validHex, valid.byteLength), tempPath: path.join(custodyRoot, validHex) },
      { ref: ref("9".repeat(64), 4), tempPath: path.join(custodyRoot, "missing") },
    ];
    const request = attemptRequest(staged, { leg: async () => ({ ...succeededLeg(), pendingEvidence, custodyTempDir: custodyRoot }) });
    expect((await executePhaseAttempt(request)).status).toBe("parked");
    const read = await readPreparationRun(staged.root, staged.binding);
    expect(read.status === "ok" && read.run.state).toBe("recovery-required");
    expect(read.status === "ok" && read.run.executionOwner).toBeUndefined();
    expect((await readPreparationEvidence(staged.root, evidenceLocation(staged), preHex)).status).toBe("ok");
    expect((await readPreparationEvidence(staged.root, evidenceLocation(staged), validHex)).status).toBe("absent");
  });

  it("publishes nothing to the authoritative store when the commit parks on drift", async () => {
    const output = path.join(custodyRoot, "out.json");
    await writeFile(output, BYTES);
    const drifted = providerAuthority({ providerPinDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`) });
    const request = attemptRequest(staged, {
      authorityResolver: driftingResolver(providerAuthority(), drifted), leg: leg(completedWithArtifact(output, HEX)),
    });
    expect((await executePhaseAttempt(request)).status).toBe("parked");
    expect((await readPreparationEvidence(staged.root, evidenceLocation(staged), HEX)).status).toBe("absent");
  });
});
