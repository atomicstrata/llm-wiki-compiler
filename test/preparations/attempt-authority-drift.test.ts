/**
 * @file test/preparations/attempt-authority-drift.test.ts
 * @description Leg-K commit gate (design section 15.3): a late leg result lands
 * only when the lease, run state, and RE-RESOLVED authority still match the
 * sealed intent. A rotated lease nonce (cancel/supersede/recover), a run driven
 * out of `running`, a receiptless phase whose live authority is re-resolved to a
 * different snapshot, or a provider pin observed differently than sealed all park
 * the result fail-closed instead of committing it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import { appendProjectedTransitionLocked, readPreparationRun } from "../../src/preparations/run-store.js";
import type { AppendPreparationTransitionInput, PreparationRunContentV1 } from "../../src/preparations/run-types.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { attemptRequest, driftingResolver, fixedResolver, providerAuthority, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";

let staged: StagedPreparation;
beforeEach(async () => { staged = await stagePreparation(); });
afterEach(() => staged.cleanup());

/** Resolve normally at launch and with a different pin at commit. */
function driftingRequest() {
  const drifted = providerAuthority({ providerPinDigest: parseSha256Digest(`sha256:${"f".repeat(64)}`) });
  return attemptRequest(staged, { authorityResolver: driftingResolver(providerAuthority(), drifted) });
}

/** Mutate the live run under the lock, simulating a concurrent control move. */
async function mutateRun(input: AppendPreparationTransitionInput, project: (next: PreparationRunContentV1) => PreparationRunContentV1): Promise<void> {
  await acquireMutationLockBlocking(staged.root, "ordinary");
  try {
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error(read.status);
    await appendProjectedTransitionLocked(staged.root, staged.binding, preparationRunPredecessor(read.run), input, project);
  } finally {
    await releaseLock(staged.root);
  }
}

const RUNNING_PROGRESS = (phaseState: "running" = "running"): AppendPreparationTransitionInput => ({
  type: "phase-progressed", stateAfter: "running", actor: { id: "recover", surface: "cli" },
  at: new Date().toISOString(), payload: { kind: "phase", phaseInstanceId: `phi_${"9".repeat(64)}`, phaseState },
});

describe("preparation attempt authority drift", () => {
  it("parks a late result after the lease nonce is rotated", async () => {
    const leg = async () => {
      await mutateRun(RUNNING_PROGRESS(), (next) => ({ ...next, executionOwner: { ...next.executionOwner!, leaseNonce: "rotated" } }));
      return succeededLeg();
    };
    expect(await executePhaseAttempt(attemptRequest(staged, { leg }))).toEqual({ status: "parked", reason: "lease-drift" });
  });

  it("parks a late result after the run leaves running (cancellation)", async () => {
    const leg = async () => {
      await mutateRun({ type: "cancelling", stateAfter: "cancelling", actor: { id: "c", surface: "cli" }, at: new Date().toISOString(), payload: { kind: "none" } }, (next) => next);
      return succeededLeg();
    };
    expect(await executePhaseAttempt(attemptRequest(staged, { leg }))).toEqual({ status: "parked", reason: "run-not-running-cancelling" });
  });

  it("parks a late result when the observed provider pin drifts from the seal", async () => {
    const leg = async () => ({ ...succeededLeg(), observedProviderPinDigest: parseSha256Digest(`sha256:${"e".repeat(64)}`) });
    expect(await executePhaseAttempt(attemptRequest(staged, { leg }))).toEqual({ status: "parked", reason: "provider-pin-drift" });
  });

  it("parks a receiptless phase whose live authority re-resolves differently at commit", async () => {
    const request = driftingRequest();
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "authority-drift" });
  });

  it("ignores an authority resolver the leg swaps mid-attempt and still parks", async () => {
    const input = driftingRequest();
    (input as { leg: unknown }).leg = async () => {
      (input as { authorityResolver: unknown }).authorityResolver = driftingResolver(providerAuthority(), providerAuthority());
      return succeededLeg();
    };
    expect(await executePhaseAttempt(input)).toEqual({ status: "parked", reason: "authority-drift" });
  });

  it("durably parks a drifted attempt to recovery-required with the owner cleared", async () => {
    const request = driftingRequest();
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "authority-drift" });
    const read = await readPreparationRun(staged.root, staged.binding);
    expect(read.status === "ok" && read.run.state).toBe("recovery-required");
    expect(read.status === "ok" && read.run.executionOwner).toBeUndefined();
  });

  const pending = (byteCount: number, digit: string) => ({
    ref: {
      kind: "x", mediaType: "application/json", provenanceLabel: "p", digest: parseSha256Digest(`sha256:${digit.repeat(64)}`),
      byteCount, sensitivity: "ordinary" as const, retention: "audit" as const,
      producer: { kind: "host" as const, contractDigest: parseSha256Digest(`sha256:${"2".repeat(64)}`) }, untrusted: true as const,
    }, tempPath: "/nonexistent",
  });

  it("parks a single output that exceeds the sealed phase output ceiling", async () => {
    const request = attemptRequest(staged, { leg: async () => ({ ...succeededLeg(), pendingEvidence: [pending(2048, "1")] }) });
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "output-bytes-exceed-sealed-bound" });
  });

  it("parks aggregate output bytes that exceed the sealed phase ceiling", async () => {
    const request = attemptRequest(staged, { leg: async () => ({ ...succeededLeg(), pendingEvidence: [pending(600, "1"), pending(600, "3")] }) });
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "aggregate-output-bytes-exceed-sealed-bound" });
  });

  it("parks an outcome whose invocation count exceeds the sealed bound", async () => {
    const request = attemptRequest(staged, { leg: async () => ({ ...succeededLeg(), invocationCount: 5 }) });
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "invocations-exceed-sealed-bound" });
  });

  it("parks an outcome whose broker-request count exceeds the sealed bound", async () => {
    const request = attemptRequest(staged, { leg: async () => ({ ...succeededLeg(), brokerRequestCount: 1 }) });
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "broker-requests-exceed-sealed-bound" });
  });

  it("parks an outcome whose effect count exceeds the sealed bound", async () => {
    const effect = { receipt: { providerPinDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`), outcome: "refused" } as never, effectIndex: 0 };
    const request = attemptRequest(staged, { leg: async () => ({ ...succeededLeg(), effects: [effect] }) });
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "effects-exceed-sealed-bound" });
  });

  it("ignores a swapped resolve method and still parks on drift", async () => {
    const input = driftingRequest();
    (input as { leg: unknown }).leg = async () => {
      (input.authorityResolver as { resolve: unknown }).resolve = fixedResolver(providerAuthority()).resolve;
      return succeededLeg();
    };
    expect(await executePhaseAttempt(input)).toEqual({ status: "parked", reason: "authority-drift" });
  });
});
