/**
 * @file test/operation-bundles/crash-tail-recovery.test.ts
 * @description Chunk-2 review regressions for the multi-append tail and mislabel
 * defects: a crash between park's failed outcome and its recovery-required write
 * is completed on recovery (not wedged in applying); a crash between an optional
 * projection's failure and its incompleteness warning re-appends the warning; and
 * a crash-recovered started mutation whose effect landed is labeled applied (so it
 * stays in the compensation applied-set), not skipped-idempotent.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { recoverOperationRunLocked } from "../../src/operation-bundles/recovery.js";
import type { OperationFaultInjector, OperationStoreAdapter } from "../../src/operation-bundles/adapter-types.js";
import {
  approveRequest, buildRuntime, compensatingSourceAdapter, failingProjectionAdapter, parkingSourceAdapter,
  stageSourceAndOptionalProjection, stageSourceBundle, unboundSourceAdapter,
} from "./executor-fixtures.js";

const crashOn = (target: string): OperationFaultInjector => ({
  async afterTransitionWrite(label) { if (label === target) throw new Error(`crash after ${target}`); },
});

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-crash-tail-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Approve+apply a source bundle that crashes after apply, then recover it. */
async function crashAfterApplyThenRecover(source: OperationStoreAdapter) {
  const staged = await stageSourceBundle(root);
  const crashing = buildRuntime({ source, fault: { async afterApply() { throw new Error("crash after apply"); } } });
  await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash after apply");
  return recoverOperationRunLocked(root, approveRequest(staged, buildRuntime({ source })));
}

describe("crash-tail recovery", () => {
  it("completes a mutation park after a crash between the failed outcome and recovery-required", async () => {
    const staged = await stageSourceBundle(root);
    const crashing = buildRuntime({ source: parkingSourceAdapter(), fault: crashOn("mutation-failed") });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash after mutation-failed");
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state).toBe("recovery-required");
  });

  it("re-appends the optional incompleteness warning dropped by a crash", async () => {
    const staged = await stageSourceAndOptionalProjection(root);
    const crashing = buildRuntime({ projection: failingProjectionAdapter(), fault: crashOn("projection-failed") });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash after projection-failed");
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state).toBe("succeeded-with-warnings");
    expect(recovered.counters?.projections.failed).toBe(1);
  });

  it("labels a crash-recovered BOUND started mutation applied, keeping it in the compensation applied-set", async () => {
    const recovered = await crashAfterApplyThenRecover(compensatingSourceAdapter());
    expect(recovered.state).toBe("succeeded");
    // applied-set = outcomes filtered to `applied`; a bound effect must be here, not a false skip.
    expect(recovered.counters?.mutations).toMatchObject({ applied: 1, skipped: 0 });
  });

  it("labels a crash-recovered UNBOUND present effect skipped-idempotent, excluding it from the applied-set", async () => {
    const recovered = await crashAfterApplyThenRecover(unboundSourceAdapter());
    expect(recovered.state).toBe("succeeded");
    // Present but unbound (no per-mutation binding): recovery must NOT relabel it applied.
    expect(recovered.counters?.mutations).toMatchObject({ applied: 0, skipped: 1 });
  });
});
