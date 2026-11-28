/**
 * @file test/scale/transition.test.ts
 * @description The root-free set / prepare / status bodies over an in-memory
 * record and fake lock, preflight and (empty) embedding store: small and large
 * estimates, deferred preparation, compare-and-swap conflicts, refusals that
 * write nothing, an unavailable estimate recorded and blocking, a smaller
 * estimate keeping the larger active architecture, supersession, a parked
 * preflight, and an unreadable record.
 */

import { describe, expect, it } from "bun:test";
import { ScaleRefusalError, type ScaleRecordV1, type ScaleRequest } from "../../src/scale/contracts.js";
import { parseSizeBytes } from "../../src/scale/plan.js";
import { prepareExpectedScaleWith, scaleStatusFrom, setExpectedScaleWith } from "../../src/scale/transition.js";
import { memorySteps, refusal, type Memory } from "./memory-steps.js";


/** A fresh in-memory project with no record and ample free space. */
const fresh = (): Memory => ({ text: null, writes: 0, log: [], free: Number.MAX_SAFE_INTEGER });
const SMALL: ScaleRequest = { sizeBytes: 5_000_000, documents: 100 };
const LARGE: ScaleRequest = { sizeBytes: 50_000_000, documents: 2_000 };
const HUGE: ScaleRequest = { sizeBytes: parseSizeBytes("2TB") };
/** The record currently held by `memory`. */
const recordOf = (memory: Memory): ScaleRecordV1 => JSON.parse(memory.text!) as ScaleRecordV1;


describe("setting an estimate the local architectures serve", () => {
  it("records about 100 documents as ready on local-standard in one write, under the lock", async () => {
    const memory = fresh();
    const report = await setExpectedScaleWith(memorySteps(memory), { request: SMALL });
    expect([report.readiness, memory.writes, memory.log]).toEqual(["ready", 1, ["acquire", "release"]]);
    expect(recordOf(memory)).toMatchObject({ revision: 1, active: { architecture: "local-standard", sinceRevision: 1 }, pending: null });
  });

  it("prepares a larger local estimate, recording each step before activating local-large last", async () => {
    const memory = fresh();
    const report = await setExpectedScaleWith(memorySteps(memory), { request: LARGE });
    expect([report.readiness, memory.writes]).toEqual(["ready", 4]);
    expect(recordOf(memory)).toMatchObject({ active: { architecture: "local-large", sinceRevision: 1 }, pending: null });
  });

  it("defers preparation on request, blocking until prepare runs", async () => {
    const memory = fresh();
    expect((await setExpectedScaleWith(memorySteps(memory), { request: LARGE, prepare: false })).readiness).toBe("preparing");
    expect((await scaleStatusFrom(memorySteps(memory).record)).readiness).toBe("preparing");
    expect((await prepareExpectedScaleWith(memorySteps(memory))).readiness).toBe("ready");
  });

  it("keeps a larger active architecture when the estimate shrinks, with no downgrade", async () => {
    const memory = fresh();
    await setExpectedScaleWith(memorySteps(memory), { request: LARGE });
    const report = await setExpectedScaleWith(memorySteps(memory), { request: SMALL });
    expect([report.readiness, report.plan?.architecture]).toEqual(["ready", "local-standard"]);
    expect(recordOf(memory)).toMatchObject({ revision: 2, active: { architecture: "local-large", sinceRevision: 1 }, pending: null });
  });
});

describe("refusing a request with nothing changed", () => {
  it("refuses invalid input and a malformed revision before taking the lock", async () => {
    const memory = fresh();
    expect(await refusal(setExpectedScaleWith(memorySteps(memory), { request: { sizeBytes: 0 } }))).toBe("scale_invalid_request");
    expect(await refusal(setExpectedScaleWith(memorySteps(memory), { request: SMALL, expectedRevision: -1 }))).toBe("scale_invalid_request");
    expect([memory.writes, memory.log]).toEqual([0, []]);
  });

  it("lets exactly one of two setters at the same revision win", async () => {
    const memory = fresh();
    await setExpectedScaleWith(memorySteps(memory), { request: SMALL, expectedRevision: 0 });
    expect(await refusal(setExpectedScaleWith(memorySteps(memory), { request: LARGE, expectedRevision: 0 }))).toBe("scale_revision_conflict");
    expect([memory.writes, recordOf(memory).revision, memory.log.at(-1)]).toEqual([1, 1, "release"]);
    expect((await setExpectedScaleWith(memorySteps(memory), { request: LARGE, expectedRevision: 1 })).readiness).toBe("ready");
  });

  it("refuses set and prepare on an unreadable record and reports it, without repairing it", async () => {
    const memory = { ...fresh(), text: "{ not json" };
    expect(await refusal(setExpectedScaleWith(memorySteps(memory), { request: SMALL }))).toBe("scale_state_unreadable");
    expect(await refusal(prepareExpectedScaleWith(memorySteps(memory)))).toBe("scale_state_unreadable");
    expect(await scaleStatusFrom(memorySteps(memory).record)).toMatchObject({ readiness: "unreadable", reason: expect.stringContaining("JSON") });
    expect([memory.writes, memory.text]).toEqual([0, "{ not json"]);
  });
});

describe("an estimate this build cannot serve", () => {
  it("is recorded as unavailable, preserves the active architecture, and prepare writes nothing", async () => {
    const memory = fresh();
    await setExpectedScaleWith(memorySteps(memory), { request: LARGE });
    const report = await setExpectedScaleWith(memorySteps(memory), { request: HUGE });
    expect(report.readiness).toBe("unavailable");
    expect(recordOf(memory)).toMatchObject({ active: { architecture: "local-large" }, pending: { kind: "unavailable", exceeds: ["documents", "bytes"] } });
    expect(recordOf(memory).requested).toMatchObject({ sizeBytes: HUGE.sizeBytes, documentsBasis: "derived" });
    const writes = memory.writes;
    expect((await prepareExpectedScaleWith(memorySteps(memory))).readiness).toBe("unavailable");
    expect(memory.writes).toBe(writes);
  });

  it("is superseded by a lower estimate, which resumes supported preparation", async () => {
    const memory = fresh();
    await setExpectedScaleWith(memorySteps(memory), { request: HUGE });
    const report = await setExpectedScaleWith(memorySteps(memory), { request: LARGE });
    expect([report.readiness, report.superseded, recordOf(memory).active.architecture]).toEqual(["ready", true, "local-large"]);
  });
});

describe("a parked preflight", () => {
  it("leaves the transition blocking until space suffices, then activates", async () => {
    const memory = { ...fresh(), free: 10 };
    const parked = await setExpectedScaleWith(memorySteps(memory), { request: LARGE });
    expect(parked.readiness).toBe("parked");
    expect(recordOf(memory).pending).toMatchObject({ kind: "prepare", steps: [{ status: "parked" }, { status: "pending" }] });
    memory.free = Number.MAX_SAFE_INTEGER;
    expect((await prepareExpectedScaleWith(memorySteps(memory))).readiness).toBe("ready");
  });
});
