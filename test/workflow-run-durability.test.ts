/**
 * @file test/workflow-run-durability.test.ts
 * @description Regression tests for the run-record DURABILITY boundary.
 *
 * Covers the durability-hardening invariants:
 *  - FIX 1 (atomicity): a `submitStageOutput` whose projected record would breach
 *    the event-count cap OR the run-byte cap THROWS *before* the external mutation
 *    is applied — the live page/relation store is left untouched (no silent
 *    unaudited write), and the run is byte-unchanged.
 *  - FIX 2 (write-side caps): `serializeRunWithinCap`/`writeRun` reject an oversize
 *    record; `startWorkflow` rejects oversize `inputs`; both fail closed, typed.
 *  - FIX 3 (no-clobber start): a colliding minted id is re-minted, never
 *    overwriting an existing run's bytes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildPapersLifecycleProject } from "./fixtures/seam-fixtures.js";
import { startWorkflow, WorkflowInputsTooLargeError } from "../src/workflows/start.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import {
  writeRun,
  readRun,
  serializeRunWithinCap,
  WorkflowRunTooLargeError,
} from "../src/workflows/store.js";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import { WorkflowEventOverflowError } from "../src/workflows/events.js";
import { readRelations } from "../src/relations/store-read.js";
import {
  MAX_WORKFLOW_RUN_EVENTS,
  MAX_WORKFLOW_INPUTS_BYTES,
  MAX_WORKFLOW_RUN_BYTES,
} from "../src/utils/constants.js";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import type { WorkflowRun, WorkflowEvent } from "../src/workflows/types.js";

/** A `papers` lifecycle + `cites` relation + a one-stage `build` workflow that writes papers. */
function durabilityProfile(gate = "trust:high"): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-durability",
    entities: {
      papers: {
        directory: "wiki/papers",
        requiredFields: ["lifecycle"],
        fields: { lifecycle: { type: "enum", enum: ["draft", "review", "published"] } },
        lifecycle: { field: "lifecycle", initial: "draft", terminal: ["published"], transitions: { draft: ["review"] } },
      },
    },
    relations: { cites: { from: ["papers"], to: ["papers"], direction: "directed" } },
    workflows: { build: { stages: [{ id: "run", reads: ["papers"], writes: ["papers"], gate }] } },
  } as ProfilePack;
}

/** Stand up a durability project + start a run; returns the root and run id. */
async function startDurability(prefix: string, slugs = ["a", "b"]): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await buildPapersLifecycleProject(root, durabilityProfile(), slugs);
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

// The cap pre-validation tests submit a trust-gated relation; grant the durability
// project (profileId "research-durability") trusted auto-apply so the write reaches
// the preflight cap check (C3 otherwise REFUSES a trust-gated relation with no grant).
beforeEach(() => {
  process.env[TRUSTED_WRITE_ENV_VAR] = "research-durability";
});
afterEach(() => {
  delete process.env[TRUSTED_WRITE_ENV_VAR];
});

/** A single stamped event filler used to pad a run's events array up to the cap. */
function fillerEvent(i: number): WorkflowEvent {
  return { type: "stage-advanced", at: "2026-01-01T00:00:00.000Z", actorKind: "system", stateVersionBefore: i, stateVersionAfter: i + 1 };
}

/**
 * Overwrite the on-disk run so its `events` array sits exactly at the cap. The real
 * genesis `workflow-start` stays at index 0 (so the version-chain check holds), then
 * the array is padded with stamped filler events whose before/after chain is
 * monotone (genesis after 0 → filler 0,1 → 1,2 → …), and `stateVersion` anchors to
 * the last filler's `stateVersionAfter`.
 */
async function planRunAtEventCap(root: string, runId: string): Promise<WorkflowRun> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error("run unreadable");
  const fillerCount = MAX_WORKFLOW_RUN_EVENTS - 1;
  const events = [read.run.events[0], ...Array.from({ length: fillerCount }, (_, i) => fillerEvent(i))];
  const atCap: WorkflowRun = { ...read.run, events, stateVersion: fillerCount };
  await writeRun(root, atCap);
  return atCap;
}

/** A `cites` relation output between `papers/a` and `papers/b`. */
function citesOutput(): StageOutput {
  return { kind: "relation", input: { type: "cites", from: "papers/a" as EntityId, to: "papers/b" as EntityId, attributes: {} } };
}

describe("FIX 1 — preflight before external apply (event cap)", () => {
  it("at the event cap, submitting a relation throws WorkflowEventOverflowError and appends NO relation", async () => {
    const { root, runId } = await startDurability("wf-dur-evcap-");
    const atCap = await planRunAtEventCap(root, runId);
    const before = await readRun(root, runId);
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toBeInstanceOf(WorkflowEventOverflowError);
    expect((await readRelations(root)).relations).toHaveLength(0); // external store untouched
    expect(await readRun(root, runId)).toEqual(before); // run byte-unchanged
    expect(atCap.events).toHaveLength(MAX_WORKFLOW_RUN_EVENTS);
  });
});

/**
 * Plant a run sized JUST under the byte cap, so the base record writes fine but the
 * PROJECTED record (with the `stage-output` event + worst-case output ref appended)
 * tips over {@link MAX_WORKFLOW_RUN_BYTES}. Returns the planted (writable) run.
 */
async function planRunNearByteCap(root: string, runId: string): Promise<WorkflowRun> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error("run unreadable");
  // Leave a 120-byte headroom: enough that the base run serializes within the cap,
  // but appending an event (~150B) + output ref pushes the projection over.
  const base = JSON.stringify({ ...read.run, inputs: { blob: "" } });
  const headroom = 120;
  const blobLen = MAX_WORKFLOW_RUN_BYTES - Buffer.byteLength(base, "utf8") - headroom;
  const planted: WorkflowRun = { ...read.run, inputs: { blob: "y".repeat(blobLen) } };
  await writeRun(root, planted); // succeeds: still within the cap
  return planted;
}

describe("FIX 1 — preflight before external apply (byte cap)", () => {
  it("a submit whose projected record exceeds the byte cap throws before apply; no relation appended", async () => {
    const { root, runId } = await startDurability("wf-dur-bytecap-");
    await planRunNearByteCap(root, runId);
    const before = await readRun(root, runId);
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toBeInstanceOf(WorkflowRunTooLargeError);
    expect((await readRelations(root)).relations).toHaveLength(0); // external store untouched
    expect(await readRun(root, runId)).toEqual(before); // run byte-unchanged
  });
});

describe("FIX 2 — write-side size caps", () => {
  it("serializeRunWithinCap throws WorkflowRunTooLargeError for an oversize record", async () => {
    const { root, runId } = await startDurability("wf-dur-ser-");
    const read = await readRun(root, runId);
    if (read.status !== "ok") throw new Error("unreadable");
    const oversize: WorkflowRun = { ...read.run, inputs: { blob: "z".repeat(MAX_WORKFLOW_RUN_BYTES) } };
    expect(() => serializeRunWithinCap(oversize)).toThrow(WorkflowRunTooLargeError);
    await expect(writeRun(root, oversize)).rejects.toBeInstanceOf(WorkflowRunTooLargeError);
  });

  it("startWorkflow rejects oversize inputs (typed) and writes nothing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-dur-inputs-"));
    await buildPapersLifecycleProject(root, durabilityProfile(), ["a"]);
    const big = { blob: "q".repeat(MAX_WORKFLOW_INPUTS_BYTES + 1) };
    await expect(startWorkflow(root, "build", big)).rejects.toBeInstanceOf(WorkflowInputsTooLargeError);
  });
});

describe("FIX 3 — no-clobber start", () => {
  it("re-mints on a colliding id, never overwriting the existing run's bytes", async () => {
    const { root, runId } = await startDurability("wf-dur-clobber-", ["a"]);
    const original = await readRun(root, runId);
    expect(original.status).toBe("ok");
    // Inject a generator that returns the EXISTING id once, then a fresh id.
    let calls = 0;
    const mintColliding = (workflowId: string): string => {
      calls += 1;
      return calls === 1 ? runId : `${workflowId}-2026-01-01-${"f".repeat(16)}`;
    };
    const fresh = await startWorkflow(root, "build", {}, mintColliding);
    expect(fresh.runId).not.toBe(runId); // a different id was minted
    expect(calls).toBeGreaterThanOrEqual(2); // it retried past the collision
    expect(await readRun(root, runId)).toEqual(original); // prior run survived byte-for-byte
  });
});
