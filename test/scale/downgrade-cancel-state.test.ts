/**
 * @file test/scale/downgrade-cancel-state.test.ts
 * @description Witnesses of the pre-install cancel's crash-state classifier
 * (design v2 §4 and §6): every reviewed row, and in particular that a record
 * past the cancel revision with no receipt (F3) is never taken as proof, that
 * only the exact expected record (F2) is, and that a receipt counts only when
 * it is bound. Pure: no file system.
 */

import { describe, expect, it } from "bun:test";
import { classifyCancel, type CancelObservation, type CancelRow } from "../../src/scale/downgrade-cancel-state.js";

/** An observation with the plan's own intent in place and nothing else, overridden by `parts`. */
function seen(parts: Partial<CancelObservation>): CancelObservation {
  return { intent: "own", retired: false, record: "fence", cancel: null, receipt: null, ...parts };
}

describe("the fenced rows", () => {
  it.each<[string, Partial<CancelObservation>, CancelRow]>([
    ["F0: the fence and no cancel intent", {}, "F0"],
    ["F1: a cancel intent and the fence", { cancel: "fenced" }, "F1"],
    ["F2: a cancel intent and exactly the expected record", { cancel: "fenced", record: "expected-cancel" }, "F2"],
    ["F3: a cancel intent and a LATER record, no receipt: fails closed", { cancel: "fenced", record: "later" }, "F3"],
    ["F4: a cancel intent and any other record", { cancel: "fenced", record: "other" }, "F4"],
    ["F4: a fenced cancel intent never accepts the original record", { cancel: "fenced", record: "original" }, "F4"],
    ["F5: a bound receipt with the intent in place", { cancel: "fenced", record: "later", receipt: "bound" }, "F5"],
    ["F6: a bound receipt with the intent retired", { intent: "absent", retired: true, cancel: "fenced", record: "later", receipt: "bound" }, "F6"],
  ])("%s", (_label, parts, row) => {
    expect(classifyCancel(seen(parts))).toBe(row);
  });
});

describe("the bootstrapped rows (no record is ever written)", () => {
  it.each<[string, Partial<CancelObservation>, CancelRow]>([
    ["B0: the original record and no cancel intent", { record: "original" }, "B0"],
    ["B1: a cancel intent and the original record", { record: "original", cancel: "bootstrapped" }, "B1"],
    ["B2: a cancel intent and a positively never-fenced later record", { record: "never-fenced-later", cancel: "bootstrapped" }, "B2"],
    ["B3: a cancel intent and any other record, even a later one", { record: "later", cancel: "bootstrapped" }, "B3"],
    ["B3: a bootstrapped cancel intent never accepts a fence", { record: "fence", cancel: "bootstrapped" }, "B3"],
    ["B4: a bound receipt with the intent in place", { record: "original", cancel: "bootstrapped", receipt: "bound" }, "B4"],
    ["B5: a bound receipt with the intent retired", { intent: "absent", retired: true, record: "original", cancel: "bootstrapped", receipt: "bound" }, "B5"],
  ])("%s", (_label, parts, row) => {
    expect(classifyCancel(seen(parts))).toBe(row);
  });
});

describe("states with nothing this cancel may act on", () => {
  it.each<[string, Partial<CancelObservation>, CancelRow]>([
    ["no intent, no cancel leaves: nothing to cancel", { intent: "absent", record: "other" }, "fresh"],
    ["another plan's intent", { intent: "other" }, "foreign"],
    ["an unreadable intent", { intent: "unreadable" }, "evidence-invalid"],
    ["an unbound receipt, whatever else is true", { cancel: "fenced", record: "expected-cancel", receipt: "unbound" }, "evidence-invalid"],
    ["a bound receipt but no intent anywhere", { intent: "absent", cancel: "fenced", receipt: "bound" }, "evidence-invalid"],
    ["a cancel intent with the bootstrap intent gone and no receipt", { intent: "absent", cancel: "fenced", record: "expected-cancel" }, "evidence-invalid"],
    ["the plan's intent and a record that is neither fence nor original", { record: "other" }, "not-pre-install"],
    ["the plan's intent and a later record, no cancel intent", { record: "later" }, "not-pre-install"],
  ])("%s", (_label, parts, row) => {
    expect(classifyCancel(seen(parts))).toBe(row);
  });
});
