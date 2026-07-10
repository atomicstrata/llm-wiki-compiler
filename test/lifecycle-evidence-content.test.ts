/**
 * @file test/lifecycle-evidence-content.test.ts
 * @description Content-validation of required lifecycle evidence (FIX #7).
 *
 * `validateLifecycleTransition` gates a transition into a state whose
 * `transitionRequirements` lists evidence fields. The gate must prove the
 * evidence carries CONTENT (a non-empty string/number, or a non-empty array of
 * such scalars), not merely that the key EXISTS: a bare object, a boolean, the
 * empty/whitespace string, and `[]` must all be REJECTED.
 */

import { describe, it, expect } from "vitest";
import { validateLifecycleTransition } from "../src/profile/lifecycle.js";
import type { LifecycleDef } from "../src/profile/types.js";

/** An `ideas`-like FSM whose `failed` state requires a `failureReason`. */
const LIFECYCLE: LifecycleDef = {
  field: "status",
  initial: "proposed",
  terminal: ["failed"],
  transitions: { proposed: ["failed"] },
  transitionRequirements: { failed: ["failureReason"] },
};

/** Validate a `proposed → failed` transition carrying `failureReason: value`. */
function problemsFor(value: unknown): string[] {
  return validateLifecycleTransition(LIFECYCLE, "proposed", "failed", {
    status: "failed",
    failureReason: value,
  });
}

describe("lifecycle evidence content validation (FIX #7)", () => {
  it("admits a non-empty string and a non-empty array of strings", () => {
    expect(problemsFor("out of compute")).toEqual([]);
    expect(problemsFor(["metric regressed", "ran out of budget"])).toEqual([]);
  });

  it("admits a finite number as evidence", () => {
    expect(problemsFor(0.42)).toEqual([]);
  });

  it.each([
    ["a bare object", { any: "obj" }],
    ["a boolean true", true],
    ["a whitespace-only string", "   "],
    ["an empty array", []],
    ["an array of objects", [{ k: "v" }]],
  ])("rejects %s as missing required evidence", (_label, value) => {
    const problems = problemsFor(value);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/requires evidence field "failureReason"/);
  });
});
