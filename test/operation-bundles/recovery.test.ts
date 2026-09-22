/**
 * @file test/operation-bundles/recovery.test.ts
 * @description Task 5 recovery tests: an apply-time authority outage parks the run
 * at recovery-required, an explicit operator resume with the approve grant and
 * unchanged authority drives it to succeeded, and a resume without the grant is
 * refused.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { resumeOperationRecoveryLocked } from "../../src/operation-bundles/recovery.js";
import { approveRequest, buildRuntime, fixtureAuthority, outageAtApplyAuthority, stageSourceBundle } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-recovery-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("recovery-required parking and resume", () => {
  it("parks at recovery-required when authority is unavailable at apply", async () => {
    const staged = await stageSourceBundle(root);
    const runtime = buildRuntime({ authority: outageAtApplyAuthority() });
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, runtime));
    expect(result.state).toBe("recovery-required");
  });

  it("resumes a parked run to succeeded once authority is available again", async () => {
    const staged = await stageSourceBundle(root);
    await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ authority: outageAtApplyAuthority() })));
    const resumed = await resumeOperationRecoveryLocked(root, approveRequest(staged, buildRuntime({ authority: fixtureAuthority() })));
    expect(resumed.state).toBe("succeeded");
  });

  it("refuses to resume without the approve grant", async () => {
    const staged = await stageSourceBundle(root);
    await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ authority: outageAtApplyAuthority() })));
    const resumed = await resumeOperationRecoveryLocked(root, approveRequest(staged, buildRuntime(), []));
    expect(resumed.state).toBe("recovery-required");
    expect(resumed.problems.map((problem) => problem.code)).toContain("approval-grant-missing");
  });
});
