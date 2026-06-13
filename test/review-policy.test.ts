/**
 * Unit tests for the pure review-policy evaluator.
 *
 * These cover the page-level decision logic without running compile or touching
 * the filesystem. Compile integration tests later verify that the signals fed
 * into this function come from the final generated page artifact.
 */

import { describe, it, expect } from "vitest";
import { evaluatePolicy, isPolicyOff, type PolicySignals, type ReviewPolicy } from "../src/review/policy.js";
import type { LintResult } from "../src/linter/types.js";

const CLEAN_SIGNALS: PolicySignals = {
  confidence: 0.9,
  contradicted: false,
  schemaViolations: [],
  provenanceViolations: [],
};

const DEFAULT_POLICY: ReviewPolicy = {
  hold: [],
  lowConfidenceThreshold: 0.5,
  treatMissingConfidenceAs: "low",
};

const VIOLATION: LintResult = {
  rule: "sample-rule",
  severity: "warning",
  file: "wiki/concepts/a.md",
  message: "sample violation",
};

function policy(hold: ReviewPolicy["hold"], extra: Partial<ReviewPolicy> = {}): ReviewPolicy {
  return { ...DEFAULT_POLICY, hold, ...extra };
}

describe("evaluatePolicy", () => {
  it("returns no reasons for off or empty policy", () => {
    expect(isPolicyOff(policy([]))).toBe(true);
    expect(isPolicyOff(policy(["off"]))).toBe(true);
    expect(evaluatePolicy(CLEAN_SIGNALS, policy([]))).toEqual([]);
    expect(evaluatePolicy(CLEAN_SIGNALS, policy(["off"]))).toEqual([]);
  });

  it("supports all mode as an unconditional hold", () => {
    expect(evaluatePolicy(CLEAN_SIGNALS, policy(["all"]))).toEqual([{ code: "all" }]);
  });

  it("fires low-confidence below threshold, not at or above threshold", () => {
    const low = { ...CLEAN_SIGNALS, confidence: 0.49 };
    const atThreshold = { ...CLEAN_SIGNALS, confidence: 0.5 };
    expect(evaluatePolicy(low, policy(["low-confidence"]))[0]?.code).toBe("low-confidence");
    expect(evaluatePolicy(atThreshold, policy(["low-confidence"]))).toEqual([]);
  });

  it("treats missing confidence according to config", () => {
    const missing = { ...CLEAN_SIGNALS, confidence: undefined };
    expect(evaluatePolicy(missing, policy(["low-confidence"]))[0]?.detail).toBe("confidence missing");
    expect(evaluatePolicy(missing, policy(["low-confidence"], { treatMissingConfidenceAs: "ok" }))).toEqual([]);
  });

  it("fires contradicted, schema, and provenance reasons", () => {
    const signals: PolicySignals = {
      confidence: 0.9,
      contradicted: true,
      schemaViolations: [VIOLATION],
      provenanceViolations: [VIOLATION],
    };
    const reasons = evaluatePolicy(signals, policy([
      "contradicted",
      "schema-violating",
      "provenance-violating",
    ]));
    expect(reasons.map((r) => r.code)).toEqual([
      "contradicted",
      "schema-violating",
      "provenance-violating",
    ]);
  });

  it("unions multiple matching modes", () => {
    const signals = { ...CLEAN_SIGNALS, confidence: 0.1, contradicted: true };
    const reasons = evaluatePolicy(signals, policy(["low-confidence", "contradicted"]));
    expect(reasons.map((r) => r.code)).toEqual(["low-confidence", "contradicted"]);
  });
});

