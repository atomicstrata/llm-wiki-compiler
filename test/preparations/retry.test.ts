/**
 * @file test/preparations/retry.test.ts
 * @description Host-owned bounded retry classification (design section 16.5).
 * Retry follows only a settled failure whose host problem code is on the plan's
 * closed allowlist within the attempt budget; it NEVER follows an unknown or
 * applied effect, integrity failure, drift, schema/custody failure, or isolation
 * outage. Every retry mints a fresh deterministic attempt id, the logical broker
 * effect identity stays stable across attempts, and the paid read-only preview
 * exposes already-spent and maximum additional cost.
 */

import { describe, expect, it } from "vitest";
import { deriveAttemptId } from "../../src/preparations/ids.js";
import {
  classifyRetry, deriveLogicalBrokerEffectId, retryCostPreview, type AttemptPolicyV1, type RetryClassificationInputV1,
} from "../../src/preparations/attempts/retry.js";

const PHASE = `phi_${"a".repeat(64)}` as const;
const policy = (over: Partial<AttemptPolicyV1> = {}): AttemptPolicyV1 => ({
  maximumAttempts: 3, retryableProblemCodes: ["provider-timeout"], backoffClass: "short-host-jitter", requireFreshAuthorityCheck: true, ...over,
});
const input = (over: Partial<RetryClassificationInputV1> = {}): RetryClassificationInputV1 => ({
  policy: policy(), phaseInstanceId: PHASE, attemptIndex: 0, phaseState: "failed", problem: "provider-timeout", effectOutcomes: [], ...over,
});

describe("retry classification", () => {
  it("retries an allowlisted failure within budget with a fresh deterministic attempt id", () => {
    const decision = classifyRetry(input());
    expect(decision).toEqual({ kind: "retry", nextAttemptIndex: 1, nextAttemptId: deriveAttemptId(PHASE, 1), backoffClass: "short-host-jitter" });
  });

  it("exhausts when the next attempt index reaches the maximum", () => {
    expect(classifyRetry(input({ attemptIndex: 2 }))).toEqual({ kind: "exhausted", reason: "maximum-attempts-reached" });
  });

  it("forbids retry for a problem code not on the allowlist", () => {
    expect(classifyRetry(input({ problem: "provider-refused" }))).toEqual({ kind: "forbidden", reason: "problem-not-on-retryable-allowlist" });
  });

  it("forbids retry after a structurally unsafe drift class regardless of the allowlist", () => {
    expect(classifyRetry(input({ problem: "authority-drift", policy: policy({ retryableProblemCodes: ["authority-drift"] }) })))
      .toEqual({ kind: "forbidden", reason: "non-retryable-authority-drift" });
  });

  it("forbids retry when an effect was applied or its outcome is unknown", () => {
    expect(classifyRetry(input({ effectOutcomes: ["applied"] }))).toEqual({ kind: "forbidden", reason: "effect-forbids-retry" });
    expect(classifyRetry(input({ effectOutcomes: ["outcome-unknown"] }))).toEqual({ kind: "forbidden", reason: "effect-forbids-retry" });
  });

  it("forbids retry when the host recorded no problem code or the phase did not fail", () => {
    expect(classifyRetry(input({ problem: undefined }))).toEqual({ kind: "forbidden", reason: "no-host-problem-code" });
    expect(classifyRetry(input({ phaseState: "recovery-required" })).kind).toBe("forbidden");
  });

  it("forbids retry for a negative or non-integer durable attempt index", () => {
    expect(classifyRetry(input({ attemptIndex: -1 }))).toEqual({ kind: "forbidden", reason: "attempt-index-invalid" });
    expect(classifyRetry(input({ attemptIndex: 1.5 }))).toEqual({ kind: "forbidden", reason: "attempt-index-invalid" });
  });
});

describe("logical broker effect identity", () => {
  it("stays stable across attempts and varies by effect index", () => {
    const first = deriveLogicalBrokerEffectId(PHASE, 0);
    const retryObserved = deriveLogicalBrokerEffectId(PHASE, 0);
    expect(retryObserved).toBe(first);
    expect(deriveLogicalBrokerEffectId(PHASE, 1)).not.toBe(first);
    expect(first.startsWith("lef_")).toBe(true);
  });
});

describe("paid read-only retry cost preview", () => {
  const bounds = { maximumBrokerRequestsPerAttempt: 4, maximumCostMicrosPerAttempt: 500 } as never;

  it("sums prior spend and exposes the exact maximum additional host-priced cost", () => {
    const preview = retryCostPreview([{ brokerRequestCount: 2, costMicros: 100 }, { brokerRequestCount: 1, costMicros: 50 }], bounds);
    expect(preview).toEqual({ alreadySpentBrokerRequests: 3, alreadySpentCostMicros: 150, maximumAdditionalBrokerRequests: 4, maximumAdditionalCostMicros: 500 });
  });

  it("keeps already-spent cost honestly unobserved when any prior attempt was unmetered", () => {
    const preview = retryCostPreview([{ brokerRequestCount: 2, costMicros: "unobserved" }], bounds);
    expect(preview.alreadySpentCostMicros).toBe("unobserved");
  });
});
