/**
 * @file test/trust-staged-change.test.ts
 * @description Unit coverage for the typed {@link StagedChange} model and the
 * fail-closed staged-write volume bound (`assertStagedWriteBudget`) — the CLP
 * Phase-2 deferred refinement of the candidate cap.
 *
 * These tests pin three things: (a) a `kind:"page"` StagedChange constructs and
 * round-trips with the spec fields; (b) the two-level volume bound passes only
 * within BOTH the per-call and per-session caps and otherwise throws a typed
 * {@link StagedWriteOverflowError} that names the breached cap and the numbers
 * (fail closed — never silently clamp); (c) the default cap constants are
 * exported and sane (per-session ≥ per-call), mirroring the existing
 * 200-pending-candidate ceiling.
 */

import { describe, it, expect } from "vitest";
import {
  type StagedChange,
  type CandidateKind,
  type HeldReasonCode,
  assertStagedWriteBudget,
  StagedWriteOverflowError,
  StagedWriteInputError,
  DEFAULT_STAGED_WRITE_PER_CALL,
  DEFAULT_STAGED_WRITE_PER_SESSION,
} from "../src/trust/staged-change.js";
import type { TrustDecision } from "../src/trust/decision.js";

/** A representative `kind:"page"` StagedChange built from the spec fields. */
function pageStagedChange(): StagedChange {
  const trustDecision: TrustDecision = "stage-for-review";
  return {
    id: "stg_0001",
    kind: "page",
    target: { entityType: "person", slug: "ada-lovelace", id: "person/ada-lovelace" as never },
    operation: "create",
    planned: [],
    heldReasons: ["manual-review-requested"],
    trustDecision,
    createdAt: "2026-06-18T00:00:00.000Z",
  };
}

describe("StagedChange model", () => {
  it("constructs and round-trips a kind:page change with the spec fields", () => {
    const change = pageStagedChange();
    expect(change.kind satisfies CandidateKind).toBe("page");
    expect(change.target).toMatchObject({ entityType: "person", slug: "ada-lovelace" });
    expect(change.planned).toEqual([]);
    expect(change.trustDecision).toBe("stage-for-review");
  });

  it("accepts every defined CandidateKind and an open-union HeldReasonCode", () => {
    const kinds: CandidateKind[] = [
      "page", "relation", "artifact", "lifecycle-transition", "workflow-gate",
    ];
    expect(kinds).toHaveLength(5);
    const reasons: HeldReasonCode[] = ["trust-blocked", "human-gate", "custom-code"];
    expect(reasons).toContain("trust-blocked");
  });
});

describe("default staged-write caps", () => {
  it("exports sane per-call and per-session caps (per-session >= per-call)", () => {
    expect(DEFAULT_STAGED_WRITE_PER_CALL).toBeGreaterThan(0);
    expect(DEFAULT_STAGED_WRITE_PER_SESSION).toBeGreaterThanOrEqual(DEFAULT_STAGED_WRITE_PER_CALL);
  });

  it("anchors the per-session cap to the existing 200 pending-candidate ceiling", () => {
    expect(DEFAULT_STAGED_WRITE_PER_SESSION).toBe(200);
    expect(DEFAULT_STAGED_WRITE_PER_CALL).toBe(50);
  });
});

describe("assertStagedWriteBudget", () => {
  const caps = { perCall: 50, perSession: 200 };

  it("passes when within both the per-call and per-session caps", () => {
    expect(() => assertStagedWriteBudget(100, 50, caps)).not.toThrow();
    expect(() => assertStagedWriteBudget(0, 1, caps)).not.toThrow();
  });

  it("throws StagedWriteOverflowError naming the per-call cap when requested > perCall", () => {
    try {
      assertStagedWriteBudget(0, 51, caps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StagedWriteOverflowError);
      expect((err as StagedWriteOverflowError).message).toContain("per-call");
      expect((err as StagedWriteOverflowError).message).toMatch(/51.*50/);
    }
  });

  it("throws StagedWriteOverflowError naming the per-session cap when existing + requested > perSession", () => {
    try {
      assertStagedWriteBudget(180, 30, caps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StagedWriteOverflowError);
      expect((err as StagedWriteOverflowError).message).toContain("per-session");
      expect((err as StagedWriteOverflowError).message).toMatch(/210.*200/);
    }
  });

  it("fails closed exactly at the per-session boundary + 1 (never clamps)", () => {
    expect(() => assertStagedWriteBudget(150, 50, caps)).not.toThrow();
    expect(() => assertStagedWriteBudget(151, 50, caps)).toThrow(StagedWriteOverflowError);
  });

  it("rejects a negative requested rather than failing open", () => {
    expect(() => assertStagedWriteBudget(0, -50, caps)).toThrow(StagedWriteInputError);
  });

  it("rejects a NaN requested rather than failing open", () => {
    expect(() => assertStagedWriteBudget(0, Number.NaN, caps)).toThrow(StagedWriteInputError);
  });

  it("rejects a non-integer requested rather than failing open", () => {
    expect(() => assertStagedWriteBudget(0, 49.9, caps)).toThrow(StagedWriteInputError);
  });

  it("rejects a negative or non-integer existingCount", () => {
    expect(() => assertStagedWriteBudget(-1, 1, caps)).toThrow(StagedWriteInputError);
    expect(() => assertStagedWriteBudget(10.5, 1, caps)).toThrow(StagedWriteInputError);
    expect(() => assertStagedWriteBudget(Number.NaN, 1, caps)).toThrow(StagedWriteInputError);
  });
});
