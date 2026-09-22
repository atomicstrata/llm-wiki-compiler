/**
 * @file test/preparations/attempt-recovery.test.ts
 * @description One fixture for every attempt recovery classification (design
 * section 16.4) plus the durable park path (section 24.4). It proves the ordered
 * fail-closed classifier, that `unavailable` is NEVER `not-started` (an unknown
 * launch boundary can never authorize first execution), that recovery re-observes
 * broker effects rather than trusting process memory, and that a durable park
 * clears the execution owner so the run is left recovery-required.
 */

import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { appendProjectedTransitionLocked, readPreparationRun } from "../../src/preparations/run-store.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import { sealAttemptContext, attemptIntentProjector } from "../../src/preparations/attempts/start.js";
import { mintAttemptLease } from "../../src/preparations/attempts/lease.js";
import { deriveAttemptId } from "../../src/preparations/ids.js";
import { readPreparationManifest } from "../../src/preparations/manifest-store.js";
import {
  authorizesFirstExecution, cancellationObservedForRecovery, classifyAttemptRecovery, parkAttemptForRecoveryLocked,
  recoveryNextMove, recoveryReadClass, reObserveEffects, type AttemptRecoveryFactsV1,
} from "../../src/preparations/recovery.js";
import { writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";
import { stagePreparation, phaseInstanceIdFor, type StagedPreparation } from "./attempt-fixture.js";

const base: AttemptRecoveryFactsV1 = {
  observationsAvailable: true, conflict: false, reObservedEffectOutcomes: [],
  resultCustodyComplete: false, checkpointResumable: false, launchBoundaryCrossed: true, providerEnded: false,
};
const facts = (over: Partial<AttemptRecoveryFactsV1>): AttemptRecoveryFactsV1 => ({ ...base, ...over });

describe("attempt recovery classification fixtures", () => {
  it("classifies every observation into its exact class", () => {
    expect(classifyAttemptRecovery(facts({ launchBoundaryCrossed: false }))).toBe("not-started");
    expect(classifyAttemptRecovery(facts({ checkpointResumable: true }))).toBe("checkpointed");
    expect(classifyAttemptRecovery(facts({ resultCustodyComplete: true }))).toBe("result-custodied");
    expect(classifyAttemptRecovery(facts({ providerEnded: true }))).toBe("failed-settled");
    // BOTH CONJUNCTS OF `failed-settled`, isolated. The row above sets only
    // `providerEnded` against a base whose boundary is already crossed, so it
    // is satisfied by EITHER half alone — measured: replacing `providerEnded`
    // with `true` left the whole 7,875-test suite green, and so did dropping
    // the boundary comparison. A conjunct nothing can see is untested however
    // the test is named.
    //
    // A provider that has NOT ended cannot be failed-settled however certain
    // the boundary is: the attempt may still be running.
    expect(classifyAttemptRecovery(facts({ providerEnded: false, launchBoundaryCrossed: true })))
      .toBe("unavailable");
    // And an UNKNOWN boundary can never become failed-settled however certainly
    // the provider ended — an unknown boundary degrades, it does not settle.
    expect(classifyAttemptRecovery(facts({ providerEnded: true, launchBoundaryCrossed: "unknown" })))
      .toBe("unavailable");
    expect(classifyAttemptRecovery(facts({ reObservedEffectOutcomes: ["applied"] }))).toBe("effect-settled");
    expect(classifyAttemptRecovery(facts({ reObservedEffectOutcomes: ["outcome-unknown"] }))).toBe("outcome-unknown");
    expect(classifyAttemptRecovery(facts({ observationsAvailable: false }))).toBe("unavailable");
    expect(classifyAttemptRecovery(facts({ conflict: true }))).toBe("conflict");
  });

  it("never classifies an unknown launch boundary as not-started", () => {
    expect(classifyAttemptRecovery(facts({ launchBoundaryCrossed: "unknown" }))).toBe("unavailable");
  });

  it("lets an unknown effect dominate a custodied result or resumable checkpoint", () => {
    expect(classifyAttemptRecovery(facts({ reObservedEffectOutcomes: ["outcome-unknown"], resultCustodyComplete: true, checkpointResumable: true }))).toBe("outcome-unknown");
  });

  it("maps each classification to its authorized next move", () => {
    expect(recoveryNextMove("outcome-unknown")).toBe("recovery-required-never-auto-retry");
    expect(recoveryNextMove("effect-settled")).toBe("continue-without-duplicating");
    expect(recoveryNextMove("not-started")).toBe("start-new-attempt-if-policy-allows");
    expect(recoveryNextMove("conflict")).toBe("park-with-bounded-evidence");
  });
});

describe("first-execution authorization and durable read taxonomy", () => {
  it("authorizes first execution only for absent or proved not-started", () => {
    expect(authorizesFirstExecution("absent")).toBe(true);
    expect(authorizesFirstExecution("not-started")).toBe(true);
    for (const c of ["unavailable", "conflict", "outcome-unknown", "integrity-invalid"] as const) expect(authorizesFirstExecution(c)).toBe(false);
  });

  it("maps a not-ok run read to its park-vs-deny class", () => {
    expect(recoveryReadClass({ status: "absent" })).toBe("absent");
    expect(recoveryReadClass({ status: "unavailable", detail: "x", code: "run-integrity-invalid" })).toBe("integrity-invalid");
    expect(recoveryReadClass({ status: "unavailable", detail: "x", code: "run-leaf-unavailable" })).toBe("unavailable");
  });
});

describe("recovery re-checks cancellation", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("observes cancellation from a durable cancel state or a present advisory", async () => {
    staged = await stagePreparation();
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error("run unavailable");
    expect(await cancellationObservedForRecovery(staged.root, read.run)).toBe(false);
    expect(await cancellationObservedForRecovery(staged.root, { ...read.run, state: "cancelling" })).toBe(true);
    await writePreparationCancelLockFree(staged.root, { workspaceId: staged.binding.workspaceId, runId: staged.binding.runId, requester: "op", at: "2026-07-22T00:00:00.000Z", nonce: "0".repeat(32) });
    expect(await cancellationObservedForRecovery(staged.root, read.run)).toBe(true);
  });
});

describe("broker re-observation never trusts memory", () => {
  it("parks on an unavailable or thrown observation and reports observed outcomes otherwise", async () => {
    expect(await reObserveEffects({ reObserve: async () => ({ status: "unavailable", outcomes: [] }) })).toMatchObject({ observationsAvailable: false });
    expect(await reObserveEffects({ reObserve: async () => { throw new Error("io"); } })).toMatchObject({ observationsAvailable: false });
    expect(await reObserveEffects({ reObserve: async () => ({ status: "conflict", outcomes: [] }) })).toMatchObject({ conflict: true });
    expect(await reObserveEffects({ reObserve: async () => ({ status: "observed", outcomes: ["applied"] }) })).toMatchObject({ reObservedEffectOutcomes: ["applied"] });
  });
});

describe("durable park clears the execution owner", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("appends recovery-required and leaves no running-with-owner zombie", async () => {
    staged = await stagePreparation();
    const phaseInstanceId = phaseInstanceIdFor(staged.binding, "collect");
    await driveRunningWithOwner(staged, phaseInstanceId);
    const running = await readPreparationRun(staged.root, staged.binding);
    if (running.status !== "ok") throw new Error("expected a running run");
    const owner = running.run.executionOwner!;
    expect(owner).toBeDefined();
    await acquireLock(staged.root, { quiet: true });
    try {
      await parkAttemptForRecoveryLocked({ root: staged.root, binding: staged.binding, run: running.run, phaseInstanceId, attemptId: owner.attemptId, leaseNonce: owner.leaseNonce, principal: { id: "op", surface: "cli" }, at: "2026-07-22T00:00:10.000Z" });
    } finally { await releaseLock(staged.root); }
    const parked = await readPreparationRun(staged.root, staged.binding);
    if (parked.status !== "ok") throw new Error("expected a parked run");
    expect(parked.run.state).toBe("recovery-required");
    expect(parked.run.executionOwner).toBeUndefined();
    expect(parked.run.phaseSummaries[0]?.state).toBe("recovery-required");
  });

  it("refuses to park a run that is not running with a fencing owner", async () => {
    staged = await stagePreparation();
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error("run unavailable");
    const phaseInstanceId = phaseInstanceIdFor(staged.binding, "collect");
    await acquireLock(staged.root, { quiet: true });
    try {
      await expect(parkAttemptForRecoveryLocked({
        root: staged.root, binding: staged.binding, run: read.run, phaseInstanceId,
        attemptId: deriveAttemptId(phaseInstanceId, 0), leaseNonce: "n", principal: { id: "op", surface: "cli" }, at: "2026-07-22T00:00:00.000Z",
      })).rejects.toThrow(/owner-active run whose owner/);
    } finally { await releaseLock(staged.root); }
  });
});

/** Drive a staged planned run to `running` with a live execution owner recorded. */
async function driveRunningWithOwner(staged: StagedPreparation, phaseInstanceId: `phi_${string}`): Promise<void> {
  const manifestRead = await readPreparationManifest(staged.root, staged.binding.workspaceId, staged.binding.preparationId);
  if (manifestRead.status !== "ok") throw new Error("manifest unavailable");
  const phase = manifestRead.manifest.plan.phases.find((p) => p.logicalPhaseId === "collect")!;
  const sealed = sealAttemptContext({
    manifest: manifestRead.manifest, executor: phase.executor!, bounds: phase.bounds,
    extras: { inputExposureSetDigest: staged.binding.manifestDigest, providerPinDigest: staged.binding.manifestDigest },
    attemptId: deriveAttemptId(phaseInstanceId, 0), phaseInstanceId, logicalPhaseId: "collect", disposition: phase.disposition,
    lease: mintAttemptLease("2026-07-22T00:00:00.000Z"), stateVersionAtSeal: 1,
  });
  await acquireLock(staged.root, { quiet: true });
  try {
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error("run unavailable");
    await appendProjectedTransitionLocked(staged.root, staged.binding, preparationRunPredecessor(read.run), {
      type: "phase-started", stateAfter: "running", actor: { id: "op", surface: "cli" }, at: "2026-07-22T00:00:01.000Z",
      payload: { kind: "phase", phaseInstanceId, phaseState: "running" },
    }, attemptIntentProjector(sealed, 1));
  } finally { await releaseLock(staged.root); }
}
