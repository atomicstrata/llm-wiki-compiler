/**
 * @file test/preparations/run-parse-spend.test.ts
 * @description The durable phase-summary spend grammar. The signed run record
 * re-parses on every read, so these fields are the loader's one chance to refuse
 * a measurement a cost preview would otherwise go on to report as fact. It pins
 * both halves of the schema change: a malformed present value is rejected, and a
 * record written before the fields existed still parses exactly as it did.
 */

import { describe, expect, it } from "vitest";
import {
  PHASE_SUMMARY_OPTIONAL_FIELDS, PHASE_SUMMARY_REQUIRED_FIELDS, parsePhaseSummary,
} from "../../src/preparations/run-parse-helpers.js";
import { worstPhase } from "../../src/preparations/run-budget.js";

const PHASE_INSTANCE_ID = `phi_${"f".repeat(64)}`;

/** A minimal valid phase summary carrying no spend fields at all. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phaseInstanceId: PHASE_INSTANCE_ID, logicalPhaseId: "collect", state: "succeeded",
    disposition: "required", attemptCount: 1, invocationCount: 1, brokerRequestCount: 0,
    effectCount: 0, ...overrides,
  };
}

describe("durable phase-summary spend grammar", () => {
  it("parses a record written before the spend fields existed", () => {
    const parsed = parsePhaseSummary(summary());
    expect(Object.hasOwn(parsed, "tokenCount")).toBe(false);
    expect(Object.hasOwn(parsed, "costMicros")).toBe(false);
  });

  it("accepts a measured zero as the observation it is", () => {
    expect(parsePhaseSummary(summary({ tokenCount: 0, costMicros: 0 }))).toMatchObject({ tokenCount: 0, costMicros: 0 });
  });

  it("refuses a negative cost", () => {
    expect(() => parsePhaseSummary(summary({ costMicros: -1 }))).toThrow(/costMicros/);
  });

  it("refuses a fractional cost", () => {
    expect(() => parsePhaseSummary(summary({ costMicros: 1.5 }))).toThrow(/costMicros/);
  });

  it("refuses a negative or fractional token count", () => {
    expect(() => parsePhaseSummary(summary({ tokenCount: -1 }))).toThrow(/tokenCount/);
    expect(() => parsePhaseSummary(summary({ tokenCount: 0.5 }))).toThrow(/tokenCount/);
  });

  it("refuses the unobserved sentinel as a stored value: absence is the record", () => {
    expect(() => parsePhaseSummary(summary({ costMicros: "unobserved" }))).toThrow(/costMicros/);
  });

  it("refuses an unknown spend-shaped field", () => {
    expect(() => parsePhaseSummary(summary({ costUsd: 1 }))).toThrow(/unknown field/);
  });

  // The staging-time byte proof is only sound if its widest phase summary carries
  // every field the parser will later accept. Derived from the parser's own list
  // so the next optional field cannot under-charge the proof silently.
  it("charges the staging byte budget for every field the parser accepts", () => {
    const charged = new Set(Object.keys(worstPhase()));
    const accepted = [...PHASE_SUMMARY_REQUIRED_FIELDS, ...PHASE_SUMMARY_OPTIONAL_FIELDS];
    expect(accepted.filter((field) => !charged.has(field))).toEqual([]);
  });
});
