/**
 * @file test/operation-bundles/recovery-plan.test.ts
 * @description Task 6 authority tests for planRecoveryBundleLocked: it requires a
 * recovery-required original, the exact original manifest digest, the approve
 * grant, and bounded closed action input, and compiles the host planner's draft
 * into an ordinary immutable bundle left awaiting-approval with recoversBundleId
 * set — through the same staging validator (a malformed draft is rejected).
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { planRecoveryBundleLocked, RecoveryPlanError, type RecoveryPlanRequest } from "../../src/operation-bundles/recovery-plan.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import { OPERATOR_PRINCIPAL, parkedSourceBundle, sourceRecoveryPlanner, stageSourceBundle, WORKSPACE, type StagedBundle } from "./executor-fixtures.js";

const fixturePlanner = sourceRecoveryPlanner;

function planRequest(staged: StagedBundle, overrides: Partial<RecoveryPlanRequest> = {}): RecoveryPlanRequest {
  return {
    workspaceId: WORKSPACE, originalBundleId: staged.bundleId, originalManifestDigest: staged.manifestDigest,
    principal: OPERATOR_PRINCIPAL, actionInput: { note: "retry the retain" }, ...overrides,
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-recplan-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("planRecoveryBundleLocked", () => {
  it("stages an ordinary recovery bundle awaiting approval with recoversBundleId set", async () => {
    const staged = await parkedSourceBundle(root);
    const result = await planRecoveryBundleLocked(root, planRequest(staged), fixturePlanner());
    expect(result.wrote).toBe(true);
    const manifest = await readOperationManifest(root, WORKSPACE, result.manifest.bundleId);
    expect(manifest.status === "ok" && manifest.manifest.recoversBundleId).toBe(staged.bundleId);
  });

  it("rejects an original that is not recovery-required", async () => {
    const staged = await stageSourceBundle(root); // awaiting-approval, never parked
    await expect(planRecoveryBundleLocked(root, planRequest(staged), fixturePlanner())).rejects.toMatchObject({ code: "bundle-recovery-required" });
  });

  it("rejects a wrong original manifest digest", async () => {
    const staged = await parkedSourceBundle(root);
    const wrong = planRequest(staged, { originalManifestDigest: `sha256:${"9".repeat(64)}` as OperationDigest });
    await expect(planRecoveryBundleLocked(root, wrong, fixturePlanner())).rejects.toMatchObject({ code: "review-digest-mismatch" });
  });

  it("rejects a caller without the approve grant", async () => {
    const staged = await parkedSourceBundle(root);
    const ungranted = planRequest(staged, { principal: { ...OPERATOR_PRINCIPAL, grants: [] } });
    await expect(planRecoveryBundleLocked(root, ungranted, fixturePlanner())).rejects.toBeInstanceOf(RecoveryPlanError);
  });

  it("rejects oversize action input as invalid", async () => {
    const staged = await parkedSourceBundle(root);
    const huge = planRequest(staged, { actionInput: { blob: "x".repeat(20_000) } });
    await expect(planRecoveryBundleLocked(root, huge, fixturePlanner())).rejects.toMatchObject({ code: "review-item-invalid" });
  });
});
