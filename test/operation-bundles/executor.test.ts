/**
 * @file test/operation-bundles/executor.test.ts
 * @description Task 5 state-machine tests for approveAndApplyOperationBundleLocked:
 * the happy path settles to succeeded through the real Foundation writers, a
 * missing approve grant refuses, and an already-terminal run is idempotent.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { MAX_RETAINED_SOURCE_BYTES } from "../../src/operation-bundles/constants.js";
import { readDurableOperationLeafBuffer } from "../../src/operation-bundles/durable-leaf.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { approveRequest, buildRuntime, payloadDigest, stageSourceBundle, WORKSPACE } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-executor-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("approveAndApplyOperationBundleLocked", () => {
  it("approves and applies a source-retain bundle to succeeded", async () => {
    const bytes = Buffer.from("retained source\n");
    const staged = await stageSourceBundle(root, bytes);
    const runtime = buildRuntime();
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, runtime));
    expect(result.state).toBe("succeeded");
    expect(result.counters?.mutations).toMatchObject({ attempted: 1, applied: 1 });
    const paths = operationPaths(root, WORKSPACE);
    const stored = await readDurableOperationLeafBuffer(root, paths.sourceFile(payloadDigest(bytes)), paths.sourcesRoot, MAX_RETAINED_SOURCE_BYTES);
    expect(stored.kind).toBe("ok");
  });

  it("refuses without the approve grant, leaving the run awaiting-approval", async () => {
    const staged = await stageSourceBundle(root);
    const runtime = buildRuntime();
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, runtime, []));
    expect(result.state).toBe("awaiting-approval");
    expect(result.problems.map((problem) => problem.code)).toContain("approval-grant-missing");
  });

  it("is idempotent once the run has reached a terminal state", async () => {
    const staged = await stageSourceBundle(root);
    const runtime = buildRuntime();
    await approveAndApplyOperationBundleLocked(root, approveRequest(staged, runtime));
    const again = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, runtime));
    expect(again.state).toBe("succeeded");
    expect(again.problems).toEqual([]);
  });
});
