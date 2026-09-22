/**
 * @file test/operation-bundles/compensation-verification.test.ts
 * @description F6 regression (INV-11 no-false-success): a compensator's returned
 * status is a self-report and must not be trusted alone. When `compensate` reports
 * `reverted` but the effect is still observably applied, compensation must NOT
 * record `completed` or settle `compensated`; it re-observes and parks at
 * recovery-required so the still-live effect is never falsely reported gone.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compensateOperationBundleLocked } from "../../src/operation-bundles/compensation.js";
import {
  approveRequest, buildRuntime, falselyRevertingSourceAdapter,
  parkViaMidApplyCancel, stageCompensatableBundle,
} from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-comp-verify-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("compensation re-observes before reporting success", () => {
  it("parks instead of recording completed when the effect is still applied", async () => {
    const staged = await stageCompensatableBundle(root);
    const source = falselyRevertingSourceAdapter();
    await parkViaMidApplyCancel(root, staged, source);
    const result = await compensateOperationBundleLocked(root, approveRequest(staged, buildRuntime({ source })), "cancellation");
    expect(result.state).toBe("recovery-required");
    expect(result.counters?.compensations.completed ?? 0).toBe(0);
  });
});
