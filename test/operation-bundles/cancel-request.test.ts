/**
 * @file test/operation-bundles/cancel-request.test.ts
 * @description Task 7 tests for the lock-free `.cancel` advisory: create-only
 * publication, validated read-back, and the fail-closed handling of forged,
 * oversize, and symlinked files (all unavailable, never trusted).
 */

import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readCancelRequest, writeCancelRequestLockFree } from "../../src/operation-bundles/cancel-request.js";
import { mintOperationRunId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";

const WORKSPACE = "research";
const AT = "2026-07-19T00:00:00.000Z";

let root = "";
let runId = mintOperationRunId();
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "cancel-")); runId = mintOperationRunId(); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function cancelFile(): string {
  return operationPaths(root, WORKSPACE).cancelFile(runId);
}

describe("cancel request advisory", () => {
  it("creates once and reports a duplicate as exists", async () => {
    expect(await writeCancelRequestLockFree(root, { workspaceId: WORKSPACE, runId, requester: "op", at: AT })).toBe("created");
    expect(await writeCancelRequestLockFree(root, { workspaceId: WORKSPACE, runId, requester: "op", at: AT })).toBe("exists");
    const read = await readCancelRequest(root, WORKSPACE, runId);
    expect(read.status === "present" && read.request.runId).toBe(runId);
  });

  it("reports absent when no request exists", async () => {
    expect((await readCancelRequest(root, WORKSPACE, runId)).status).toBe("absent");
  });

  it("treats a request naming a different run as unavailable", async () => {
    await mkdir(path.dirname(cancelFile()), { recursive: true });
    const foreign = mintOperationRunId();
    await writeFile(cancelFile(), JSON.stringify({ schemaVersion: 1, runId: foreign, requester: "op", at: AT }));
    expect((await readCancelRequest(root, WORKSPACE, runId)).status).toBe("unavailable");
  });

  it("treats an oversize file as unavailable", async () => {
    await mkdir(path.dirname(cancelFile()), { recursive: true });
    await writeFile(cancelFile(), "x".repeat(2048));
    expect((await readCancelRequest(root, WORKSPACE, runId)).status).toBe("unavailable");
  });

  it("treats a symlinked advisory as unavailable", async () => {
    await mkdir(path.dirname(cancelFile()), { recursive: true });
    await symlink("/etc/hostname", cancelFile());
    expect((await readCancelRequest(root, WORKSPACE, runId)).status).toBe("unavailable");
  });
});
