/**
 * @file test/operation-bundles/cancel-directory-advisory.test.ts
 * @description Round-3 regression for the MID-APPLY directory advisory: a DIRECTORY
 * planted out-of-band at the lock-free `.cancel` path must not defeat advisory
 * removal. A non-recursive force remove throws EISDIR raw (force only suppresses
 * ENOENT), which pre-fix escaped the held-lock poll call rather than parking. The
 * poll must remove any planted shape and park resumably without a raw throw. (The
 * pre-apply directory case shares the parameterized wedge coverage in
 * cancel-semantics.test.ts.)
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import type { OperationFaultInjector } from "../../src/operation-bundles/adapter-types.js";
import {
  approveRequest, buildRuntime, cancelFileExists, compensatingSourceAdapter,
  plantDirectoryAdvisory, runIdOf, stageCompensatableBundle,
} from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-cancel-dir-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("directory advisory at the cancel path", () => {
  it("mid-apply: parks resumably without a raw throw when a directory is planted", async () => {
    const staged = await stageCompensatableBundle(root);
    const runId = await runIdOf(root, staged);
    let calls = 0;
    const fault: OperationFaultInjector = { async atCancelSafePoint() { if (++calls === 2) await plantDirectoryAdvisory(root, runId); } };
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ source: compensatingSourceAdapter(), fault })));
    expect(result.state).toBe("recovery-required");
    expect(result.counters?.mutations.applied).toBe(1);
    expect(await cancelFileExists(root, runId)).toBe(false);
  });
});
