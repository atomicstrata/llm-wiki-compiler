/**
 * @file test/operation-bundles/read-stale-owner.test.ts
 * @description Task 8 read-only resolver test: a crashed `applying` run left by a
 * stale owner is reported as applying-stale-recovery-pending without mutating any
 * run bytes.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { resolveOperationRecoveryState } from "../../src/operation-bundles/lock-gate.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { approveRequest, buildRuntime, stageSourceBundle, WORKSPACE } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-read-stale-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("read-only stale-owner resolver", () => {
  it("reports applying-stale-recovery-pending without mutating run bytes", async () => {
    const staged = await stageSourceBundle(root);
    const crashing = buildRuntime({ fault: { async afterApply() { throw new Error("crash"); } } });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash");

    const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
    if (manifest.status !== "ok") throw new Error("manifest unreadable");
    const runFile = operationPaths(root, WORKSPACE).runFile(manifest.manifest.runId);
    const before = await readFile(runFile);

    expect(await resolveOperationRecoveryState(root)).toBe("applying-stale-recovery-pending");

    expect(await readFile(runFile)).toEqual(before);
  });
});
