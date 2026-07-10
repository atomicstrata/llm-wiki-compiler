/**
 * @file test/sdk/workflow-action-run-sdk.test.ts
 * @description Tests the EXPERIMENTAL `createWiki().runAction` method in-process.
 *
 * Over the shared run-action profile, executing the `build.start` action through
 * the SDK (surface `sdk`) mints a run and returns an `ActionRunResult` carrying
 * the action id, the `start` operation, the composed effective permission, and
 * the minted run as `result`.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWiki } from "../../src/sdk/wiki.js";
import { installRunActionProfile } from "../fixtures/run-action-profile.js";
import type { WorkflowRun } from "../../src/workflows/types.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sdk-action-run-"));
  await installRunActionProfile(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("createWiki runAction (experimental)", () => {
  it("runs a start action and returns the minted run", async () => {
    const wiki = createWiki({ root });
    const res = await wiki.runAction("build.start", {});
    expect(res.actionId).toBe("build.start");
    expect(res.operation).toBe("start");
    expect(res.effectivePermission).toBe("trusted-write");
    expect((res.result as WorkflowRun).runId).toMatch(/.+/);
  });
});
