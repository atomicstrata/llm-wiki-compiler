/**
 * @file test/workflow-store-confine.test.ts
 * @description Confinement tests for the workflow run store (dir + leaf).
 *
 * Covers: a planted symlinked run leaf pointing out of tree is neither written
 * through (victim bytes unchanged) nor read through (never returns victim bytes);
 * and an escaping `.llmwiki` dir-symlink makes reads/lists fail closed without
 * crashing the caller.
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { writeRun, readRun, listRuns, WorkflowRunIdError } from "../src/workflows/store.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "../src/workflows/types.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

/** True when `mkfifo` is runnable on this platform (POSIX only). */
function mkfifoAvailable(): boolean {
  try {
    execFileSync("mkfifo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    // BSD/macOS mkfifo has no --version; probe by feature instead.
    return process.platform !== "win32";
  }
}

const ctx = useConfinementRoots("wf-store-confine");

const RUN_ID = "build-2026-01-01-aaaa";

function runFor(runId: string): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    runId,
    workflowId: "build",
    workflowDigest: "d",
    profileDigest: "p",
    knownStageIds: [],
    status: "pending",
    currentStage: null,
    stageLog: [],
    inputs: {},
    outputs: {},
    stateVersion: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [
      { type: "workflow-start", at: "2026-01-01T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 },
    ],
    satisfiedGates: [],
  };
}

/** Path to a run's leaf inside the project. */
function leaf(root: string, runId: string): string {
  return path.join(root, LLMWIKI_DIR, "workflows", "runs", `${runId}.json`);
}

describe("workflow run store leaf-symlink confinement", () => {
  it("does not write through or read through a symlinked run leaf", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR, "workflows", "runs"), { recursive: true });
    const victim = path.join(ctx.outside, "victim.json");
    await writeFile(victim, "ORIGINAL", "utf8");
    let created = true;
    try { await symlink(victim, leaf(ctx.root, RUN_ID)); } catch { created = false; }
    if (!created) return; // skip: platform cannot create symlinks
    await writeRun(ctx.root, runFor(RUN_ID)).catch(() => {});
    expect(await readFile(victim, "utf8")).toBe("ORIGINAL"); // not written through
    const result = await readRun(ctx.root, RUN_ID);
    expect(result.status).not.toBe("ok"); // never reads the victim's bytes
  });
});

describe("workflow run store dir-symlink confinement", () => {
  it("fails closed (no crash) when .llmwiki escapes the root", async () => {
    let created = true;
    try { await symlink(ctx.outside, path.join(ctx.root, LLMWIKI_DIR), "dir"); } catch { created = false; }
    if (!created) return; // skip: platform cannot create symlinks
    const result = await readRun(ctx.root, RUN_ID);
    expect(result.status).not.toBe("ok");
    // An escaping .llmwiki is an UNAVAILABLE store, not a clean "no runs" (empty).
    expect((await listRuns(ctx.root)).status).toBe("unavailable");
  });

  it("does not traverse a symlinked intermediate workflows dir out of tree", async () => {
    // Real .llmwiki, but .llmwiki/workflows -> an out-of-tree dir with a valid run.
    await mkdir(path.join(ctx.root, LLMWIKI_DIR), { recursive: true });
    await mkdir(path.join(ctx.outside, "runs"), { recursive: true });
    await writeFile(path.join(ctx.outside, "runs", `${RUN_ID}.json`), JSON.stringify(runFor(RUN_ID)), "utf8");
    let created = true;
    try { await symlink(ctx.outside, path.join(ctx.root, LLMWIKI_DIR, "workflows"), "dir"); } catch { created = false; }
    if (!created) return; // skip: platform cannot create symlinks
    expect((await readRun(ctx.root, RUN_ID)).status).not.toBe("ok"); // never the out-of-tree bytes
    // An escaping intermediate workflows dir is UNAVAILABLE, never out-of-tree files.
    expect((await listRuns(ctx.root)).status).toBe("unavailable");
  });
});

describe("workflow run store FIFO-leaf DoS", () => {
  // A planted FIFO leaf must NOT block readRun forever; the timeout makes a
  // regression FAIL (the read hanging) rather than wedge the whole suite.
  it("treats a FIFO run leaf as unavailable instead of blocking forever", { timeout: 5000 }, async () => {
    if (!mkfifoAvailable()) return; // skip: no mkfifo on this platform
    const runsDir = path.join(ctx.root, LLMWIKI_DIR, "workflows", "runs");
    await mkdir(runsDir, { recursive: true });
    const fifoLeaf = leaf(ctx.root, RUN_ID);
    try {
      execFileSync("mkfifo", [fifoLeaf]);
    } catch {
      return; // skip: mkfifo unavailable/failed
    }
    const result = await readRun(ctx.root, RUN_ID);
    expect(result.status).toBe("unavailable");
  });
});

describe("workflow run store run-id length bound", () => {
  const tooLong = "a".repeat(5000);

  it("rejects an over-long run id on write with WorkflowRunIdError", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR), { recursive: true });
    await expect(writeRun(ctx.root, runFor(tooLong))).rejects.toBeInstanceOf(WorkflowRunIdError);
  });

  it("reports an over-long run id as unavailable on read (no ENAMETOOLONG)", async () => {
    const result = await readRun(ctx.root, tooLong);
    expect(result.status).toBe("unavailable");
  });
});
