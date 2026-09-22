/**
 * @file test/operation-bundles/recovery-blocks-compensating.test.ts
 * @description F5 regression: a run left `compensating` by a crash mid-compensation
 * is a real resumable in-flight state whose observations an unrelated mutation must
 * not invalidate. The recovery gate must block an ordinary mutation while such a run
 * exists, and the read-only resolver must not report it clean.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquireMutationLock, RecoveryGateError, resolveOperationRecoveryState } from "../../src/operation-bundles/lock-gate.js";
import { compensateOperationBundleLocked } from "../../src/operation-bundles/compensation.js";
import { readOperationRun } from "../../src/operation-bundles/run-store.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { readOperationKey } from "../../src/operation-bundles/key-epoch.js";
import { operationManifestDigest } from "../../src/operation-bundles/manifest-parse.js";
import {
  approveRequest, buildRuntime, compensatingSourceAdapter,
  parkViaMidApplyCancel, stageCompensatableBundle, WORKSPACE, type StagedBundle,
} from "./executor-fixtures.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-comp-block-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Drive a bundle to a crash-interrupted `compensating` state on disk. */
async function crashDuringCompensation(staged: StagedBundle): Promise<void> {
  const source = compensatingSourceAdapter();
  await parkViaMidApplyCancel(root, staged, source);
  const crashing = buildRuntime({ source, fault: { async beforeCompensate() { throw new Error("crash mid-compensation"); } } });
  await expect(compensateOperationBundleLocked(root, approveRequest(staged, crashing), "cancellation")).rejects.toThrow("crash mid-compensation");
}

/** Read the on-disk run state for a staged bundle. */
async function stateOf(staged: StagedBundle): Promise<string> {
  const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  if (manifest.status !== "ok") throw new Error("manifest unreadable");
  const key = await readOperationKey(root);
  if (key.status !== "ok") throw new Error("key unreadable");
  const read = await readOperationRun(root, {
    runId: manifest.manifest.runId, bundleId: manifest.manifest.bundleId,
    manifestDigest: operationManifestDigest(manifest.manifest) as OperationDigest,
    workspaceId: WORKSPACE, keyEpochId: key.keyEpochId,
  });
  if (read.status !== "ok") throw new Error("run unreadable");
  return read.run.state;
}

describe("recovery gate blocks a compensating run", () => {
  it("refuses an ordinary mutation while a run is crash-interrupted compensating", async () => {
    const staged = await stageCompensatableBundle(root);
    await crashDuringCompensation(staged);
    expect(await stateOf(staged)).toBe("compensating");
    await expect(acquireMutationLock(root, "ordinary")).rejects.toBeInstanceOf(RecoveryGateError);
  });

  it("does not report a compensating run as clean on the read-only resolver", async () => {
    const staged = await stageCompensatableBundle(root);
    await crashDuringCompensation(staged);
    expect(await resolveOperationRecoveryState(root)).not.toBe("clean");
  });
});
