/**
 * @file test/operation-bundles/compensation.test.ts
 * @description Task 7 five-condition compensation gate tests: compensation runs
 * only when authority is unchanged, every applied mutation is still at post-state,
 * and every applied mutation has a registered host compensator; otherwise the run
 * parks at recovery-required without a partial or false compensation.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compensateOperationBundleLocked } from "../../src/operation-bundles/compensation.js";
import {
  approveRequest, buildRuntime, compensatingSourceAdapter, fixtureSnapshot,
  parkViaMidApplyCancel, stageCompensatableBundle,
} from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-comp-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("compensateOperationBundleLocked gate", () => {
  it("compensates an applied mutation after a mid-apply cancellation", async () => {
    const staged = await stageCompensatableBundle(root);
    const source = compensatingSourceAdapter();
    await parkViaMidApplyCancel(root, staged, source);
    const result = await compensateOperationBundleLocked(root, approveRequest(staged, buildRuntime({ source })), "cancellation");
    expect(result.state).toBe("compensated");
    expect(result.counters?.compensations.completed).toBe(1);
  });

  it("parks without compensating when an applied mutation has no host compensator", async () => {
    const staged = await stageCompensatableBundle(root);
    await parkViaMidApplyCancel(root, staged); // real source adapter — no compensator
    const result = await compensateOperationBundleLocked(root, approveRequest(staged, buildRuntime()), "apply-failure");
    expect(result.state).toBe("recovery-required");
    expect(result.counters?.compensations.completed ?? 0).toBe(0);
  });

  it("parks without compensating when authority has drifted", async () => {
    const staged = await stageCompensatableBundle(root);
    const source = compensatingSourceAdapter();
    await parkViaMidApplyCancel(root, staged, source);
    const drifted = buildRuntime({ source, authority: { async computeSnapshot(request) { return { status: "ok", ...fixtureSnapshot(request, "drifted") }; } } });
    const result = await compensateOperationBundleLocked(root, approveRequest(staged, drifted), "cancellation");
    expect(result.state).toBe("recovery-required");
    expect(result.counters?.compensations.completed ?? 0).toBe(0);
  });
});
