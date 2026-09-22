/**
 * @file test/operation-bundles/recovery-bundle-settlement.test.ts
 * @description Task 6 settlement tests: the original stays recovery-required until
 * its recovery bundle reaches an accepted terminal state, then receives a durable
 * `recovered` transition; an unfinished recovery bundle leaves the original parked.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { planRecoveryBundleLocked, settleOriginalFromRecoveryLocked, type RecoverySettlementRequest } from "../../src/operation-bundles/recovery-plan.js";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { approveRequest, buildRuntime, OPERATOR_PRINCIPAL, parkedSourceBundle, sourceRecoveryPlanner, WORKSPACE, type StagedBundle } from "./executor-fixtures.js";

/** Plan a recovery bundle for a parked original and return its identities. */
async function planRecovery(root: string, original: StagedBundle): Promise<StagedBundle> {
  const plan = await planRecoveryBundleLocked(root, {
    workspaceId: WORKSPACE, originalBundleId: original.bundleId, originalManifestDigest: original.manifestDigest,
    principal: OPERATOR_PRINCIPAL, actionInput: {},
  }, sourceRecoveryPlanner());
  return { bundleId: plan.manifest.bundleId, manifestDigest: plan.manifestDigest, workspaceId: WORKSPACE };
}

function settlementRequest(original: StagedBundle, recovery: StagedBundle): RecoverySettlementRequest {
  return {
    workspaceId: WORKSPACE, originalBundleId: original.bundleId, originalManifestDigest: original.manifestDigest,
    recoveryBundleId: recovery.bundleId, recoveryManifestDigest: recovery.manifestDigest,
    principal: OPERATOR_PRINCIPAL, at: "2026-07-19T01:00:00.000Z",
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-settle-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("recovery bundle settlement", () => {
  it("recovers the original once its recovery bundle succeeds", async () => {
    const original = await parkedSourceBundle(root);
    const recovery = await planRecovery(root, original);
    const applied = await approveAndApplyOperationBundleLocked(root, approveRequest(recovery, buildRuntime()));
    expect(applied.state).toBe("succeeded");
    const settled = await settleOriginalFromRecoveryLocked(root, settlementRequest(original, recovery));
    expect(settled.state).toBe("recovered");
  });

  it("leaves the original parked when the recovery bundle is unfinished", async () => {
    const original = await parkedSourceBundle(root);
    const recovery = await planRecovery(root, original);
    const settled = await settleOriginalFromRecoveryLocked(root, settlementRequest(original, recovery));
    expect(settled.state).toBe("recovery-required");
  });
});
