/**
 * @file test/operation-bundles/cancel-semantics.test.ts
 * @description F7 regression for the three cancellation-semantics gaps: a cancel
 * present BEFORE any apply settles the run to terminal `cancelled` with no effects
 * (not applying-then-parked); cancellation is polled during the projections phase,
 * not only the authoritative phase; and a late advisory is removed on ordinary
 * terminal success so a stale request can never re-trigger.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { acquireMutationLock } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { writeCancelRequestLockFree } from "../../src/operation-bundles/cancel-request.js";
import type { OperationFaultInjector } from "../../src/operation-bundles/adapter-types.js";
import {
  approveRequest, buildRuntime, cancelFileExists, plantDirectoryAdvisory, plantSymlinkAdvisory,
  runIdOf, stageSourceAndOptionalProjection, stageSourceBundle, WORKSPACE,
} from "./executor-fixtures.js";

const AT = "2026-07-19T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-cancel-sem-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("cancellation semantics", () => {
  it("settles a pre-apply cancellation to terminal cancelled with no effects", async () => {
    const staged = await stageSourceBundle(root);
    const runId = await runIdOf(root, staged);
    await writeCancelRequestLockFree(root, { workspaceId: WORKSPACE, runId, requester: "operator", at: AT });
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    expect(result.state).toBe("cancelled");
    expect(result.counters?.mutations.applied ?? 0).toBe(0);
    expect(await cancelFileExists(root, runId)).toBe(false);
  });

  it("polls cancellation during the projections phase", async () => {
    const staged = await stageSourceAndOptionalProjection(root);
    const runId = await runIdOf(root, staged);
    let calls = 0;
    const fault: OperationFaultInjector = {
      async atCancelSafePoint() { if (++calls === 2) await writeCancelRequestLockFree(root, { workspaceId: WORKSPACE, runId, requester: "operator", at: AT }); },
    };
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ fault })));
    expect(result.state).toBe("recovery-required");
    expect(result.counters?.mutations.applied).toBe(1);
  });

  it("removes a late advisory on ordinary terminal success", async () => {
    const staged = await stageSourceBundle(root);
    const runId = await runIdOf(root, staged);
    const fault: OperationFaultInjector = {
      async beforeTerminalWrite() { await writeCancelRequestLockFree(root, { workspaceId: WORKSPACE, runId, requester: "operator", at: AT }); },
    };
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ fault })));
    expect(result.state).toBe("succeeded");
    expect(await cancelFileExists(root, runId)).toBe(false);
  });
});

// Both untrusted pre-apply shapes — a symlinked leaf and a planted directory — must
// refuse transiently without wedging the workspace, so the wedge assertions run once
// over each planter rather than being copied per shape.
const preApplyAdvisories = [
  { shape: "symlinked", plant: plantSymlinkAdvisory },
  { shape: "directory", plant: plantDirectoryAdvisory },
] as const;

describe.each(preApplyAdvisories)("unreadable pre-apply $shape advisory does not wedge the workspace", ({ plant }) => {
  it("refuses transiently, leaves the run awaiting-approval, and does not block other mutations", async () => {
    const staged = await stageSourceBundle(root);
    const runId = await runIdOf(root, staged);
    await plant(root, runId);
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    // Transient refusal: no durable park, the run stays awaiting-approval.
    expect(result.state).toBe("awaiting-approval");
    expect(result.problems.map((problem) => problem.code)).toContain("review-store-unavailable");
    // The untrusted advisory is removed so it can neither park nor flag an inventory
    // problem — the lock gate does not block the workspace.
    expect(await cancelFileExists(root, runId)).toBe(false);
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
  });

  it("still applies the same run once the advisory clears (retry after the transient refusal)", async () => {
    const staged = await stageSourceBundle(root);
    const runId = await runIdOf(root, staged);
    await plant(root, runId);
    const refused = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    expect(refused.state).toBe("awaiting-approval");
    // The refused pass already removed the untrusted advisory, so the retry proceeds.
    const retried = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    expect(retried.state).toBe("succeeded");
  });
});
