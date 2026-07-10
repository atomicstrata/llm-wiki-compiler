/**
 * @file test/workflow-events-record.test.ts
 * @description Behavioural tests for the in-record workflow event log.
 *
 * Covers: the pure `appendRunEvent` helper (stamps before/after state versions,
 * bumps the run's stateVersion, sets updatedAt, appends, never mutates the
 * input, and fails closed at the cap), and that a run carrying `events` /
 * `satisfiedGates` round-trips through the confined store while a run MISSING
 * `events` fails closed on read.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRun } from "../src/workflows/store.js";
import {
  appendRunEvent,
  WorkflowEventOverflowError,
} from "../src/workflows/events.js";
import {
  WORKFLOW_RUN_SCHEMA_VERSION,
  type WorkflowRun,
  type WorkflowEvent,
} from "../src/workflows/types.js";
import { MAX_WORKFLOW_RUN_EVENTS } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { validDigest, expectSignedRoundTrip } from "./fixtures/run-integrity.js";

const ctx = useConfinementRoots("wf-events");

function genesisEvent(at: string): WorkflowEvent {
  return { type: "workflow-start", at, actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 };
}

function sampleRun(runId: string, stateVersion = 0): WorkflowRun {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    runId,
    workflowId: "build",
    workflowDigest: validDigest("wf"),
    profileDigest: validDigest("pf"),
    knownStageIds: ["draft", "review"],
    status: "pending",
    currentStage: "draft",
    stageLog: [{ stageId: "draft", status: "pending" }],
    inputs: {},
    outputs: {},
    stateVersion,
    startedAt: at,
    updatedAt: at,
    events: [genesisEvent(at)],
    satisfiedGates: [],
  };
}

/** Directory holding the per-run JSON files, for planting raw fixtures. */
function runsDir(root: string): string {
  return path.join(root, ".llmwiki", "workflows", "runs");
}

describe("appendRunEvent", () => {
  it("stamps before/after, bumps stateVersion, sets updatedAt, appends, and does not mutate the input", () => {
    const run = sampleRun("build-2026-01-01-aaaa", 3);
    const next = appendRunEvent(run, {
      type: "stage-advanced",
      at: "2026-02-02T00:00:00.000Z",
      actorKind: "agent",
      stageId: "review",
    });
    expect(next.stateVersion).toBe(4);
    expect(next.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(next.events).toHaveLength(2);
    const appended = next.events[1];
    expect(appended.stateVersionBefore).toBe(3);
    expect(appended.stateVersionAfter).toBe(4);
    expect(run.stateVersion).toBe(3);
    expect(run.events).toHaveLength(1);
  });

  it("throws WorkflowEventOverflowError at the event cap", () => {
    const run = sampleRun("build-2026-01-01-bbbb");
    run.events = Array.from({ length: MAX_WORKFLOW_RUN_EVENTS }, () =>
      genesisEvent("2026-01-01T00:00:00.000Z"),
    );
    expect(() =>
      appendRunEvent(run, { type: "run-failed", at: "2026-02-02T00:00:00.000Z", actorKind: "system" }),
    ).toThrow(WorkflowEventOverflowError);
  });
});

describe("event-bearing run store round-trip", () => {
  it("round-trips a run carrying events and satisfiedGates", async () => {
    const run = appendRunEvent(sampleRun("build-2026-01-01-cccc"), {
      type: "gate-approved",
      at: "2026-03-03T00:00:00.000Z",
      actorKind: "human",
      gateId: "g1",
    });
    run.satisfiedGates = ["human:g1"];
    await expectSignedRoundTrip(ctx.root, run);
  });

  it("fails closed (unavailable) on a run missing the events array", async () => {
    const id = "build-2026-01-01-dddd";
    const { events: _omit, ...legacy } = sampleRun(id);
    await mkdir(runsDir(ctx.root), { recursive: true });
    await writeFile(path.join(runsDir(ctx.root), `${id}.json`), JSON.stringify(legacy), "utf8");
    expect((await readRun(ctx.root, id)).status).toBe("unavailable");
  });
});
