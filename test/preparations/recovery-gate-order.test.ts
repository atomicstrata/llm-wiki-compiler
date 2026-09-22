/**
 * @file test/preparations/recovery-gate-order.test.ts
 * @description The shared recovery gate runs in the exact order page journal →
 * Milestone A recovery → preparation recovery (design section 15.1). The
 * preparation leg SETTLES a handoff whose bundle create outran its `handed-off`
 * transition, but never blocks unrelated work: a bundle-absent in-flight handoff
 * is left for its own command's resume. Because the leg runs strictly AFTER
 * Milestone A recovery, a corrupted bundle is discovered first and preparation
 * settlement never runs while a bundle needs recovery.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { acquireMutationLock } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import {
  stageReadyPreparation, handoffRequest, tamperOperationRun, expectRunState as expectState,
  stageDivergentReservedGenesis, CRASH_BEFORE_STAGE as crash, CRASH_AFTER_STAGE as crashAfterStage,
} from "./handoff-fixture.js";

const root = useTempRoot();

describe("recovery gate order: page journal, Milestone A, then preparation", () => {
  it("settles a fully-created handoff during an unrelated ordinary acquisition", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: crashAfterStage }))).rejects.toThrow("crash");
    expect(await acquireMutationLock(root.dir, "ordinary")).toBe(true);
    await releaseLock(root.dir);
    await expectState(root.dir, binding, "handed-off");
  });

  it("leaves a bundle-absent in-flight handoff for its own command without blocking", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: crash }))).rejects.toThrow("crash");
    expect(await acquireMutationLock(root.dir, "ordinary")).toBe(true);
    await releaseLock(root.dir);
    await expectState(root.dir, binding, "handoff-started");
    const resumed = await handoffPreparation(root.dir, handoffRequest(binding));
    expect(resumed.outcome).toBe("resumed");
  });

  it("parks rather than settles a reserved bundle staged with a divergent genesis authority", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: crash }))).rejects.toThrow("crash");
    await stageDivergentReservedGenesis(root.dir, binding);
    expect(await acquireMutationLock(root.dir, "ordinary")).toBe(true);
    await releaseLock(root.dir);
    await expectState(root.dir, binding, "recovery-required");
  });

  it("runs Milestone A recovery before preparation settlement", async () => {
    const a = await stageReadyPreparation(root.dir);
    const resultA = await handoffPreparation(root.dir, handoffRequest(a));
    const b = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(b, "grace", { faultsForTest: crashAfterStage }))).rejects.toThrow("crash");
    await tamperOperationRun(root.dir, a.workspaceId, resultA.operationRunId);
    // The Milestone A leg detects the corrupted bundle and blocks BEFORE the
    // preparation leg runs, so the settle-able handoff below is left untouched.
    await expect(acquireMutationLock(root.dir, "ordinary")).rejects.toMatchObject({ code: "bundle-recovery-blocking" });
    await expectState(root.dir, b, "handoff-started");
  });
});
