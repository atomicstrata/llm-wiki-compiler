/**
 * @file test/workflow-terminal-cap-escape.test.ts
 * @description BUG 1 regression: a run AT the event/byte cap must still be
 * retireable (cancel/fail), while a NON-terminal op at the cap keeps failing
 * closed (back-pressure preserved).
 *
 * The contract: a cap bounds GROWTH, never blocks TERMINATION. A run padded to
 * `MAX_WORKFLOW_RUN_EVENTS` events can still be `cancel`led / `fail`ed — the
 * terminal op COMPACTS the event log (genesis + an `events-truncated` marker +
 * the recent tail) so the terminal status flip always persists. A run whose
 * serialized record exceeds `MAX_WORKFLOW_RUN_BYTES` can still be terminated via
 * a minimized record (large inputs/outputs dropped with a marker). A non-terminal
 * `advance` at the cap still throws.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { writeRun, readRun } from "../src/workflows/store.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { failWorkflow } from "../src/workflows/fail.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { WorkflowEventOverflowError } from "../src/workflows/events.js";
import { MAX_WORKFLOW_RUN_EVENTS, MAX_WORKFLOW_RUN_BYTES } from "../src/utils/constants.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowEvent, type WorkflowRun } from "../src/workflows/types.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { validDigest, plantSignedRun } from "./fixtures/run-integrity.js";

/** Bytes the integrity stamp adds to a serialized record (`,"integrity":"<64hex>"`). */
const INTEGRITY_BYTES = 80;

const ctx = useConfinementRoots("wf-cap-escape");

// Install a `build` workflow whose first stage is `review`, matching the planted
// capped run's `currentStage`, so `advanceWorkflow` resolves the stage and reaches
// the event-cap back-pressure throw (rather than failing on an unknown workflow).
beforeEach(async () => {
  await installWorkflowProfile(ctx.root, buildWorkflowProfile([
    { id: "review", reads: ["ideas"], writes: [] },
    { id: "publish", reads: ["experiments"], writes: [] },
  ]));
});

/** A workflow-start genesis event stamped at version 0. */
function genesis(): WorkflowEvent {
  return { type: "workflow-start", at: "2026-01-01T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 };
}

/** Build a running run whose `events` array is padded to `count` entries. */
function cappedRun(runId: string, count: number): WorkflowRun {
  const events: WorkflowEvent[] = [genesis()];
  for (let i = 1; i < count; i++) {
    events.push({ type: "stage-advanced", at: "2026-01-01T00:00:00.000Z", actorKind: "system", stateVersionBefore: i, stateVersionAfter: i + 1 });
  }
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, runId, workflowId: "build",
    workflowDigest: validDigest("wf"), profileDigest: validDigest("pf"), knownStageIds: ["review"],
    status: "running", currentStage: "review", stageLog: [{ stageId: "review", status: "running" }],
    inputs: {}, outputs: {}, stateVersion: count, startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", events, satisfiedGates: [],
  };
}

describe("BUG 1 — terminal ops escape the event cap via compaction", () => {
  it("cancel SUCCEEDS on a run padded to the event cap, compacting with a marker", async () => {
    const runId = "build-2026-01-01-cap1";
    await writeRun(ctx.root, cappedRun(runId, MAX_WORKFLOW_RUN_EVENTS));
    const run = await cancelWorkflow(ctx.root, runId);
    expect(run.status).toBe("cancelled");
    expect(run.events.length).toBeLessThanOrEqual(MAX_WORKFLOW_RUN_EVENTS);
    expect(run.events[0]).toMatchObject({ type: "workflow-start" });
    expect(run.events.some((e) => e.type === "events-truncated")).toBe(true);
    expect(run.events.at(-1)).toMatchObject({ type: "run-cancelled" });
  });

  it("fail SUCCEEDS on a run padded to the event cap, compacting with a marker", async () => {
    const runId = "build-2026-01-01-cap2";
    await writeRun(ctx.root, cappedRun(runId, MAX_WORKFLOW_RUN_EVENTS));
    const run = await failWorkflow(ctx.root, runId, "boom");
    expect(run.status).toBe("failed");
    expect(run.events[0]).toMatchObject({ type: "workflow-start" });
    expect(run.events.some((e) => e.type === "events-truncated")).toBe(true);
    expect(run.events.at(-1)).toMatchObject({ type: "run-failed", detail: "boom" });
  });

  it("a NON-terminal advance at the cap STILL throws (back-pressure preserved)", async () => {
    const runId = "build-2026-01-01-cap3";
    await writeRun(ctx.root, cappedRun(runId, MAX_WORKFLOW_RUN_EVENTS));
    await expect(advanceWorkflow(ctx.root, runId)).rejects.toBeInstanceOf(WorkflowEventOverflowError);
    const read = await readRun(ctx.root, runId);
    expect(read.status === "ok" && read.run.status).toBe("running");
  });
});

/**
 * Build a run that is READABLE (record ≤ the byte cap) but so close to it that
 * appending one terminal event would push the WRITTEN record over the cap — the
 * byte-cap zombie. The blob is sized from the actual serialized base so the record
 * lands at `cap - HEADROOM`: readable, but no normal terminal append could fit.
 */
function nearByteCapRun(runId: string): WorkflowRun {
  const run = cappedRun(runId, 3);
  const HEADROOM = 80; // < a terminal event's serialized size, so an append overflows
  const overhead = Buffer.byteLength(JSON.stringify({ ...run, outputs: { blob: "" } }), "utf8");
  // Leave room for the integrity stamp the signed-plant adds, so the readable record stays ≤ cap.
  run.outputs = { blob: "x".repeat(MAX_WORKFLOW_RUN_BYTES - overhead - HEADROOM - INTEGRITY_BYTES) };
  return run;
}

/**
 * Read `runId` back and assert it persisted `ok` with the terminal `status`,
 * within the byte cap, and carrying the `fields-truncated` truncation marker.
 */
async function expectTerminalWithinCap(root: string, runId: string, status: "cancelled" | "failed"): Promise<void> {
  const read = await readRun(root, runId);
  expect(read.status).toBe("ok");
  if (read.status !== "ok") return;
  expect(read.run.status).toBe(status);
  expect(Buffer.byteLength(JSON.stringify(read.run), "utf8")).toBeLessThanOrEqual(MAX_WORKFLOW_RUN_BYTES);
  expect(read.run.events.some((e) => e.type === "fields-truncated")).toBe(true);
}

describe("BUG 1 — terminal ops escape the BYTE cap via a minimized record", () => {
  it("cancel SUCCEEDS on a near-byte-cap run whose terminal append would overflow", async () => {
    const runId = "build-2026-01-01-byte1";
    await plantSignedRun(ctx.root, nearByteCapRun(runId));
    const cancelled = await cancelWorkflow(ctx.root, runId);
    expect(cancelled.status).toBe("cancelled");
    await expectTerminalWithinCap(ctx.root, runId, "cancelled");
  });

  it("fail SUCCEEDS on a near-byte-cap run whose terminal append would overflow", async () => {
    const runId = "build-2026-01-01-byte2";
    await plantSignedRun(ctx.root, nearByteCapRun(runId));
    const failed = await failWorkflow(ctx.root, runId, "boom");
    expect(failed.status).toBe("failed");
    await expectTerminalWithinCap(ctx.root, runId, "failed");
  });
});

/**
 * Build a `running` run dominated by a LARGE `stageLog` (a many-stage def), sized
 * to land ~HEADROOM bytes under the byte cap. Clearing inputs/outputs does NOT
 * shrink it (they are already empty), so ONLY a guaranteed-minimal TOMBSTONE
 * fallback can fit the terminal write — the residual re-attack on BUG 1.
 */
function bigStageLogRun(runId: string): WorkflowRun {
  const run = cappedRun(runId, 3);
  const HEADROOM = 50; // < the run-cancelled + fields-truncated events, so an append overflows
  // The signed write adds the integrity stamp, so size against `cap - HEADROOM - integrity`.
  const ceiling = MAX_WORKFLOW_RUN_BYTES - HEADROOM - INTEGRITY_BYTES;
  const entry = (i: number) => ({ stageId: `stage-${i.toString(36)}`, status: "completed" as const });
  // Grow stageLog until the serialized record lands just under the ceiling.
  let n = 0;
  while (Buffer.byteLength(JSON.stringify({ ...run, stageLog: [...Array(n)].map((_, i) => entry(i)) }), "utf8") < ceiling) {
    n += 64;
  }
  // Step back to the last size that fits within the ceiling.
  do { n -= 1; } while (n > 0 && Buffer.byteLength(JSON.stringify({ ...run, stageLog: [...Array(n)].map((_, i) => entry(i)) }), "utf8") > ceiling);
  run.stageLog = [...Array(n)].map((_, i) => entry(i));
  return run;
}

describe("BUG 1 (residual) — non-clearable field near the cap: tombstone fallback", () => {
  it("cancel SUCCEEDS on a near-byte-cap run dominated by stageLog (tombstone)", async () => {
    const runId = "build-2026-01-01-stagelog1";
    await writeRun(ctx.root, bigStageLogRun(runId)); // real write path, within cap
    const cancelled = await cancelWorkflow(ctx.root, runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.stageLog).toEqual([]); // tombstoned: the dominating field is dropped
    await expectTerminalWithinCap(ctx.root, runId, "cancelled");
  });

  it("fail SUCCEEDS on a near-byte-cap run dominated by stageLog (tombstone)", async () => {
    const runId = "build-2026-01-01-stagelog2";
    await writeRun(ctx.root, bigStageLogRun(runId));
    const failed = await failWorkflow(ctx.root, runId, "boom");
    expect(failed.status).toBe("failed");
    expect(failed.stageLog).toEqual([]);
    await expectTerminalWithinCap(ctx.root, runId, "failed");
  });
});
