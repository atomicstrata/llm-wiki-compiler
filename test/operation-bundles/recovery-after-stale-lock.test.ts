/**
 * @file test/operation-bundles/recovery-after-stale-lock.test.ts
 * @description Task 8 stale-reclamation test: a bundle apply crashed mid-flight
 * leaves an `applying` run; a later ordinary mutation is blocked by the recovery
 * gate (bundle-recovery-blocking), an explicit recovery settles the run, and the
 * ordinary mutation then proceeds.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { recoverOperationRunLocked } from "../../src/operation-bundles/recovery.js";
import { acquireMutationLock, RecoveryGateError } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { approveRequest, buildRuntime, stageSourceBundle } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-stale-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("recovery after a stale lock", () => {
  it("blocks an ordinary mutation, recovers the crashed run, then proceeds", async () => {
    const staged = await stageSourceBundle(root);
    const crashing = buildRuntime({ fault: { async afterApply() { throw new Error("crash after apply"); } } });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash after apply");

    // A different mutating entry is blocked by the gate while the run is applying.
    await expect(acquireMutationLock(root, "ordinary")).rejects.toBeInstanceOf(RecoveryGateError);

    // The recovery intent is allowed; drive the crashed run to settlement.
    expect(await acquireMutationLock(root, "recovery")).toBe(true);
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state).toBe("succeeded");
    await releaseLock(root);

    // With the run settled, the ordinary mutation now passes the gate.
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
  });
});
