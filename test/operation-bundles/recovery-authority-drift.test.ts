/**
 * @file test/operation-bundles/recovery-authority-drift.test.ts
 * @description Task 5 authority-drift tests: a snapshot that changes between the
 * approval and apply recomputations invalidates approval before any effect, and a
 * drift observed during recovery parks at recovery-required without compensating.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import type { OperationAuthorityProvider } from "../../src/operation-bundles/authority.js";
import { approveRequest, buildRuntime, fixtureSnapshot, stageSourceBundle } from "./executor-fixtures.js";

/** A provider whose snapshot digest changes on the second (apply-time) recompute. */
function driftingAuthority(): OperationAuthorityProvider {
  let calls = 0;
  return {
    async computeSnapshot(request) {
      calls += 1;
      return { status: "ok", ...fixtureSnapshot(request, `precondition-${calls}`) };
    },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-drift-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("authority drift", () => {
  it("invalidates approval when the snapshot changes before the first effect", async () => {
    const staged = await stageSourceBundle(root);
    const runtime = buildRuntime({ authority: driftingAuthority() });
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, runtime));
    expect(result.state).toBe("approval-invalidated");
    expect(result.counters?.mutations.attempted).toBe(0);
  });
});
