/**
 * @file test/scale/gate.test.ts
 * @description The scale-readiness leg of the shared mutation gate.
 *
 * Over recorded fake legs (the root-free `acquireMutationLockWith` body): the
 * leg runs after the portable block and BEFORE the lifecycle and settlement
 * legs, so a refusal appends nothing; `scale` is the one intent it lets
 * through and `recovery` still bypasses everything; a refusal releases the
 * lock. On real disk: no record changes nothing, a pending transition refuses
 * an ordinary acquisition with the lock released, and the scale intent passes.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { acquireMutationLock, acquireMutationLockWith, type RecoveryGateSteps } from "../../src/operation-bundles/lock-gate.js";
import { ScaleGateError } from "../../src/scale/gate.js";
import { setExpectedScale } from "../../src/scale/transition.js";
import { releaseLock } from "../../src/utils/lock.js";

/** Every gate step as a recorded fake; the scale leg answers `refusal`. */
function fakeSteps(log: string[], refusal: ScaleGateError | null): RecoveryGateSteps {
  return {
    acquireLock: async () => { log.push("lock"); return true; },
    acquireLockBlocking: async () => { log.push("lock-blocking"); },
    releaseLock: async () => { log.push("release"); },
    recoverJournal: async () => { log.push("journal"); return { status: "clean" } as never; },
    detectBundleRecovery: async () => { log.push("bundle"); return null; },
    portableBlock: async () => { log.push("portable"); return null; },
    scaleBlock: async () => { log.push("scale"); return refusal; },
    gateLifecycle: async (_root, intent) => { log.push(`lifecycle ${intent}`); return null; },
    settleHandoffs: async () => { log.push("settle"); },
  };
}

/** The calls one acquisition at `intent` made, and how it settled. */
async function acquireAt(intent: Parameters<typeof acquireMutationLockWith>[2], refusal: ScaleGateError | null): Promise<[string[], string]> {
  const log: string[] = [];
  const settled = await acquireMutationLockWith(fakeSteps(log, refusal), "/project", intent).then(() => "acquired", (error: Error) => error.name);
  return [log, settled];
}

describe("the scale leg's place in the gate", () => {
  it("runs after the portable block and before lifecycle and settlement; scale skips it, recovery bypasses all", async () => {
    expect(await acquireAt("ordinary", null)).toEqual([["lock", "journal", "bundle", "portable", "scale", "lifecycle ordinary", "settle"], "acquired"]);
    expect(await acquireAt("scale", null)).toEqual([["lock", "journal", "bundle", "portable", "lifecycle scale", "settle"], "acquired"]);
    expect(await acquireAt("recovery", null)).toEqual([["lock"], "acquired"]);
  });

  it("refuses every other intent before lifecycle and settlement, releasing the lock", async () => {
    const pending = new ScaleGateError("scale-transition-pending");
    for (const intent of ["ordinary", "review", "reset", "handoff"] as const) {
      expect(await acquireAt(intent, pending)).toEqual([["lock", "journal", "bundle", "portable", "scale", "release"], "ScaleGateError"]);
    }
    expect(await acquireAt("portable", pending)).toEqual([["lock", "journal", "bundle", "scale", "release"], "ScaleGateError"]);
  });
});

describe("the scale leg on real disk", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-gate-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("changes nothing without a record, refuses during a transition with the lock released, and passes the scale intent", async () => {
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
    await setExpectedScale(root, { request: { documents: 2_000 }, prepare: false });
    await expect(acquireMutationLock(root, "ordinary")).rejects.toMatchObject({ name: "ScaleGateError", block: "scale-transition-pending" });
    expect(await readdir(path.join(root, ".llmwiki"))).not.toContain("lock");
    expect(await acquireMutationLock(root, "scale")).toBe(true);
    await releaseLock(root);
  });
});
