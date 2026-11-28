/**
 * @file test/scale/record-downgrade.test.ts
 * @description The `downgrade` pending kind of a version 2/3 scale record: an
 * explicit scale-down in progress, the fence every build observes.
 *
 * It round trips; it is refused unless the project is ACTIVE `local-indexed`,
 * the target is a smaller local layout, the plan is a SHA-256 digest, the
 * fields are exactly its own, and the recorded estimate plans no larger than
 * the target. While it is held, the report reads `downgrading`, the gate
 * blocks with `scale-downgrade-pending`, and neither `set` nor `prepare` may
 * supersede it (`scale_downgrade_pending`, nothing written).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { ScaleRefusalError } from "../../src/scale/contracts.js";
import { scaleGateRefusal } from "../../src/scale/gate.js";
import type { ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { nextRecord } from "../../src/scale/next-record.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { parseAnyScaleRecord, serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { prepareExpectedScaleWith, scaleStatusFrom, setExpectedScaleWith } from "../../src/scale/transition.js";
import { memorySteps, refusal } from "./memory-steps.js";

const PLAN = "a".repeat(64);

/** An active indexed version 3 record scaling down to `target` with a lowered estimate of `documents`. */
function downgrading(target: "local-standard" | "local-large" = "local-standard", documents = 100): ScaleRecordV2 {
  const indexed = nextRecord(null, planScaleV2({ documents: 8_000 }), [], ["segmented-compile-state-1"]) as ScaleRecordV2;
  const lowered = nextRecord({ ...indexed, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null }, planScaleV2({ documents })) as ScaleRecordV2;
  return { ...lowered, capabilities: [{ name: "segmented-compile-state-1", status: "ready" }], pending: { kind: "downgrade", revision: lowered.revision, target, plan: PLAN } };
}

/** The record text with `patch` applied to its pending object. */
function withPending(record: ScaleRecordV2, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...record, pending: { ...record.pending, ...patch } });
}



describe("the downgrade pending kind", () => {
  it("round trips for both smaller targets and keeps the held capabilities", () => {
    for (const target of ["local-standard", "local-large"] as const) {
      const record = downgrading(target);
      expect(parseAnyScaleRecord(serializeAnyScaleRecord(record))).toEqual(record);
    }
  });

  it("is refused off an active indexed project, toward indexed, or with a malformed plan or field", () => {
    const record = downgrading();
    expect(() => parseAnyScaleRecord(JSON.stringify({ ...record, active: { architecture: "local-large", sinceRevision: 1 } }))).toThrow();
    expect(() => parseAnyScaleRecord(withPending(record, { target: "local-indexed" }))).toThrow();
    expect(() => parseAnyScaleRecord(withPending(record, { plan: "A".repeat(64) }))).toThrow(/SHA-256/);
    expect(() => parseAnyScaleRecord(withPending(record, { plan: undefined }))).toThrow();
    expect(() => parseAnyScaleRecord(withPending(record, { steps: [] }))).toThrow();
  });

  it("is refused when the recorded estimate plans larger than its target", () => {
    const large = downgrading("local-standard", 2_000);
    expect(() => parseAnyScaleRecord(serializeAnyScaleRecord(large))).toThrow(/no larger than its target/);
    expect(parseAnyScaleRecord(serializeAnyScaleRecord(downgrading("local-large", 2_000))).pending).toMatchObject({ target: "local-large" });
  });
});

describe("a project with a scale-down in progress", () => {
  it("reports downgrading, and set and prepare refuse without writing", async () => {
    const memory = { text: serializeAnyScaleRecord(downgrading()), writes: 0, log: [] as string[], free: Number.MAX_SAFE_INTEGER };
    expect((await scaleStatusFrom(memorySteps(memory).record)).readiness).toBe("downgrading");
    expect(await refusal(setExpectedScaleWith(memorySteps(memory), { request: { documents: 50 } }))).toBe("scale_downgrade_pending");
    expect(await refusal(prepareExpectedScaleWith(memorySteps(memory)))).toBe("scale_downgrade_pending");
    expect(memory.writes).toBe(0);
  });
});

describe("the gate during a scale-down", () => {
  it("blocks dependent work with scale-downgrade-pending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-downgrade-gate-"));
    try {
      await mkdir(path.join(root, ".llmwiki"));
      await writeFile(path.join(root, ".llmwiki", "scale.json"), serializeAnyScaleRecord(downgrading()));
      expect(await scaleGateRefusal(root)).toMatchObject({ name: "ScaleGateError", block: "scale-downgrade-pending" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
