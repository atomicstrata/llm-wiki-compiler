/**
 * @file test/workflow-active-run-quota.test.ts
 * @description Tests the global run quota on `startWorkflow` (H5).
 *
 * `startWorkflow` refuses once `MAX_ACTIVE_WORKFLOW_RUNS` NON-terminal runs exist (a
 * terminal run frees active quota), AND once `MAX_TOTAL_WORKFLOW_RUNS` run FILES exist
 * (so a start+cancel loop leaving terminal files behind is also bounded). The quota
 * FAILS CLOSED: an unenumerable store refuses the start rather than bypassing the cap.
 *
 * OCCUPANCY IS SEEDED; THE BOUNDARY IS DRIVEN. Filling the store to just under the
 * cap is setup, not evidence, and one `startWorkflow` per slot made each case about
 * a hundred lock/scan/sync transactions long. {@link occupyActiveSlots} mints one run
 * through `startWorkflow` and writes the rest as signed copies through the store's own
 * writer, then proves every one reads back `ok` and active. Each case then crosses the
 * cap itself, both the last admitted start and the refused one, through `startWorkflow`.
 */

import { describe, it, expect } from "bun:test";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installWorkflowProfile, buildWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow, TooManyActiveRunsError, WorkflowRunStoreUnavailableError } from "../src/workflows/start.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { mintRunId, readRun, writeRun } from "../src/workflows/store.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { MAX_ACTIVE_WORKFLOW_RUNS, MAX_TOTAL_WORKFLOW_RUNS, LLMWIKI_DIR } from "../src/utils/constants.js";
import type { WorkflowRun } from "../src/workflows/types.js";

/** Starts each cap case makes itself: the one that reaches the cap, and the one before it. */
const DRIVEN_STARTS = 2;

/** Install a single-stage read-only `build` workflow under a fresh temp root. */
async function setup(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile([{ id: "draft", reads: ["ideas"], writes: [] }]));
  return root;
}

/**
 * Occupy `count` active slots and return the one run `startWorkflow` minted.
 *
 * The first slot is a real start, which also creates the project's run key. The
 * others are that record under fresh minted ids, signed and persisted by the
 * store's own writer under the held project lock, as its contract requires. Every
 * seeded record is then read back through the store: an unreadable leaf ALSO
 * counts toward the quota, so without this a broken seed would pass the cap cases.
 */
async function occupyActiveSlots(root: string, count: number): Promise<WorkflowRun> {
  const minted = await startWorkflow(root, "build", {});
  const seeded = Array.from({ length: count - 1 }, () => ({ ...minted, runId: mintRunId("build") }));
  expect(await acquireLock(root)).toBe(true);
  try {
    await Promise.all(seeded.map((run) => writeRun(root, run)));
  } finally {
    await releaseLock(root);
  }
  const reads = await Promise.all(seeded.map((run) => readRun(root, run.runId)));
  expect(reads.map((read) => read.status === "ok" && read.run.status)).toEqual(seeded.map(() => "pending"));
  return minted;
}

/** Fill to just under the cap, then make the last admitted starts through `startWorkflow`. */
async function reachActiveCap(root: string): Promise<WorkflowRun> {
  const minted = await occupyActiveSlots(root, MAX_ACTIVE_WORKFLOW_RUNS - DRIVEN_STARTS);
  for (let driven = 0; driven < DRIVEN_STARTS; driven += 1) {
    expect((await startWorkflow(root, "build", {})).status).toBe("pending");
  }
  return minted;
}

/** Plant `count` placeholder `.json` run files (content irrelevant — listRuns only counts names). */
async function plantRunFiles(root: string, count: number): Promise<void> {
  const runsDir = path.join(root, LLMWIKI_DIR, "workflows", "runs");
  await mkdir(runsDir, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, i) => writeFile(path.join(runsDir, `r${i}.json`), "{}", "utf8")),
  );
}

/** Plant ONE slug-safe-named but UNREADABLE (corrupt-JSON) run leaf — `readRun` → unavailable. */
async function plantUnreadableLeaf(root: string): Promise<void> {
  const runsDir = path.join(root, LLMWIKI_DIR, "workflows", "runs");
  await mkdir(runsDir, { recursive: true });
  await writeFile(path.join(runsDir, "corrupt.json"), "{ not valid json", "utf8");
}

describe("startWorkflow active-run quota (H5)", () => {
  it("refuses to mint past MAX_ACTIVE_WORKFLOW_RUNS active runs", async () => {
    const root = await setup("wf-quota-cap");
    await reachActiveCap(root);
    await expect(startWorkflow(root, "build", {})).rejects.toBeInstanceOf(TooManyActiveRunsError);
  });

  it("a terminal (cancelled) run frees quota so a subsequent start succeeds", async () => {
    const root = await setup("wf-quota-free");
    const first = await reachActiveCap(root);
    await expect(startWorkflow(root, "build", {})).rejects.toBeInstanceOf(TooManyActiveRunsError);
    await cancelWorkflow(root, first.runId); // retire one → frees a slot
    const minted = await startWorkflow(root, "build", {});
    expect(minted.status).toBe("pending");
  });

  it("counts an UNREADABLE run leaf toward the active quota (no fail-open room)", async () => {
    const root = await setup("wf-quota-unreadable");
    await occupyActiveSlots(root, MAX_ACTIVE_WORKFLOW_RUNS - DRIVEN_STARTS);
    expect((await startWorkflow(root, "build", {})).status).toBe("pending"); // cap-1 readable active runs
    await plantUnreadableLeaf(root); // +1 unverifiable leaf → conservatively counts as active, reaching the cap
    await expect(startWorkflow(root, "build", {})).rejects.toBeInstanceOf(TooManyActiveRunsError);
  });
});

describe("startWorkflow total-files cap + fail-closed (H5)", () => {
  it("refuses to mint past MAX_TOTAL_WORKFLOW_RUNS run files (terminal files count)", async () => {
    const root = await setup("wf-quota-total");
    await plantRunFiles(root, MAX_TOTAL_WORKFLOW_RUNS); // all terminal/placeholder — bounds disk
    await expect(startWorkflow(root, "build", {})).rejects.toBeInstanceOf(TooManyActiveRunsError);
  });

  it("FAILS CLOSED: an unenumerable run store refuses the start (never bypasses the quota)", async () => {
    const root = await setup("wf-quota-failclosed");
    // A .llmwiki/workflows symlink escaping the project root makes listRuns `unavailable`
    // (escape) while the profile in .llmwiki/ still loads.
    const escape = await makeTempRoot("wf-quota-escape-target");
    await mkdir(path.join(escape, "runs"), { recursive: true }); // so realpath resolves (then escapes)
    let created = true;
    try {
      await symlink(escape, path.join(root, LLMWIKI_DIR, "workflows"), "dir");
    } catch {
      created = false;
    }
    if (!created) return; // skip: platform cannot create symlinks
    await expect(startWorkflow(root, "build", {})).rejects.toBeInstanceOf(WorkflowRunStoreUnavailableError);
  });
});
