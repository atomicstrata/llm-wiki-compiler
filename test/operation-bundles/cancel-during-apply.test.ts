/**
 * @file test/operation-bundles/cancel-during-apply.test.ts
 * @description Task 7 tests that a cancellation reaches a held-lock executor
 * between mutations and settles safely: a valid mid-apply request parks the run at
 * recovery-required (mid-apply can never go straight to cancelled), and an
 * unreadable (symlinked) advisory also parks rather than being ignored.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { writeCancelRequestLockFree } from "../../src/operation-bundles/cancel-request.js";
import type { OperationFaultInjector } from "../../src/operation-bundles/adapter-types.js";
import {
  approveRequest, buildRuntime, compensatingSourceAdapter, plantSymlinkAdvisory,
  runIdOf, stageCompensatableBundle, WORKSPACE, type StagedBundle,
} from "./executor-fixtures.js";

const AT = "2026-07-19T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-cancel-apply-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Apply with a fault that fires `plant` at the second cancel-safe point. */
async function applyWithSecondSafePoint(staged: StagedBundle, plant: () => Promise<void>) {
  let calls = 0;
  const fault: OperationFaultInjector = { async atCancelSafePoint() { if (++calls === 2) await plant(); } };
  return approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ source: compensatingSourceAdapter(), fault })));
}

describe("cancellation during apply", () => {
  it("parks safely at recovery-required when a valid cancellation is delivered mid-apply", async () => {
    const staged = await stageCompensatableBundle(root);
    const runId = await runIdOf(root, staged);
    const result = await applyWithSecondSafePoint(staged, () => writeCancelRequestLockFree(root, { workspaceId: WORKSPACE, runId, requester: "operator", at: AT }).then(() => undefined));
    expect(result.state).toBe("recovery-required");
    expect(result.counters?.mutations.applied).toBe(1);
  });

  it("parks when an unreadable (symlinked) advisory is planted mid-apply", async () => {
    const staged = await stageCompensatableBundle(root);
    const runId = await runIdOf(root, staged);
    const result = await applyWithSecondSafePoint(staged, () => plantSymlinkAdvisory(root, runId).then(() => undefined));
    expect(result.state).toBe("recovery-required");
    expect(result.counters?.mutations.applied).toBe(1);
  });
});
