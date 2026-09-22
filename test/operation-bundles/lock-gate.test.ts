/**
 * @file test/operation-bundles/lock-gate.test.ts
 * @description Task 8 tests for the shared recovery gate: a clean project acquires
 * and releases, a parked bundle blocks an ordinary mutation with a typed refusal
 * (and the lock is released), and the recovery intent bypasses the bundle gate.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquireMutationLock, acquireMutationLockBlocking, RecoveryGateError } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { parkedSourceBundle } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-gate-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("recovery gate", () => {
  it("acquires and releases on a clean project", async () => {
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
    await acquireMutationLockBlocking(root, "ordinary");
    await releaseLock(root);
  });

  it("blocks an ordinary mutation while a bundle is parked and releases the lock", async () => {
    await parkedSourceBundle(root);
    await expect(acquireMutationLock(root, "ordinary")).rejects.toBeInstanceOf(RecoveryGateError);
    // The lock was released on the block, so a recovery-intent acquire succeeds.
    expect(await acquireMutationLock(root, "recovery")).toBe(true);
    await releaseLock(root);
  });

  it("carries the bundle-recovery-blocking code on the refusal", async () => {
    await parkedSourceBundle(root);
    await expect(acquireMutationLockBlocking(root, "ordinary")).rejects.toMatchObject({ code: "bundle-recovery-blocking" });
  });
});
