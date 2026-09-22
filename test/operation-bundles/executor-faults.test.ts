/**
 * @file test/operation-bundles/executor-faults.test.ts
 * @description Task 5 fault-injection tests: a crash after an effect lands but
 * before its durable outcome leaves the run applying, and the observation-based
 * recovery coordinator settles it to succeeded. A crash before a transition write
 * likewise leaves a recoverable run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { recoverOperationRunLocked } from "../../src/operation-bundles/recovery.js";
import { readOperationRun } from "../../src/operation-bundles/run-store.js";
import { readOperationKey } from "../../src/operation-bundles/key-epoch.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { approveRequest, buildRuntime, readStagedRun, stageSourceBundle, WORKSPACE } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-faults-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Read the run's current state directly for assertions. */
async function runState(bundleId: `bnd_${string}`, manifestDigest: string): Promise<string> {
  const run = await readStagedRun(root, { bundleId, manifestDigest: manifestDigest as `sha256:${string}`, workspaceId: WORKSPACE });
  return run.state;
}

describe("executor fault injection and recovery", () => {
  it("recovers a crash after the effect lands but before the durable outcome", async () => {
    const staged = await stageSourceBundle(root);
    const crashing = buildRuntime({ fault: { async afterApply() { throw new Error("crash after apply"); } } });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash after apply");
    expect(await runState(staged.bundleId, staged.manifestDigest)).toBe("applying");
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state).toBe("succeeded");
    expect(recovered.counters?.mutations).toMatchObject({ attempted: 1 });
  });

  it("leaves a recoverable run when a transition write is interrupted", async () => {
    const staged = await stageSourceBundle(root);
    let writes = 0;
    const crashing = buildRuntime({ fault: { async beforeTransitionWrite() { if (++writes === 4) throw new Error("crash before write"); } } });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash before write");
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state).toBe("succeeded");
  });
});
