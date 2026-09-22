/**
 * @file test/operation-bundles/compensation-faults.test.ts
 * @description Task 7 compensation crash-injection tests: a crash before a
 * compensator, and a crash between a compensator and its durable outcome, both
 * leave the run compensating; re-running the coordinator resumes idempotently by
 * observation and settles to compensated.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compensateOperationBundleLocked } from "../../src/operation-bundles/compensation.js";
import { approveRequest, buildRuntime, compensatingSourceAdapter, parkViaMidApplyCancel, stageCompensatableBundle } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-comp-fault-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("compensation fault injection and resume", () => {
  it("resumes idempotently after a crash before a compensator", async () => {
    const staged = await stageCompensatableBundle(root);
    const source = compensatingSourceAdapter();
    await parkViaMidApplyCancel(root, staged, source);
    const crashing = buildRuntime({ source, fault: { async beforeCompensate() { throw new Error("crash before compensator"); } } });
    await expect(compensateOperationBundleLocked(root, approveRequest(staged, crashing), "cancellation")).rejects.toThrow("crash before compensator");
    const resumed = await compensateOperationBundleLocked(root, approveRequest(staged, buildRuntime({ source })), "cancellation");
    expect(resumed.state).toBe("compensated");
    expect(resumed.counters?.compensations.completed).toBe(1);
  });

  it("resumes after a crash between the compensator and its durable outcome", async () => {
    const staged = await stageCompensatableBundle(root);
    const source = compensatingSourceAdapter();
    await parkViaMidApplyCancel(root, staged, source);
    const crashing = buildRuntime({ source, fault: { async afterCompensate() { throw new Error("crash after compensator"); } } });
    await expect(compensateOperationBundleLocked(root, approveRequest(staged, crashing), "cancellation")).rejects.toThrow("crash after compensator");
    const resumed = await compensateOperationBundleLocked(root, approveRequest(staged, buildRuntime({ source })), "cancellation");
    expect(resumed.state).toBe("compensated");
  });
});
