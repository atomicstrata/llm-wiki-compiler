/**
 * @file test/preparations/identities.test.ts
 * @description Exercises every Orchestration V2 typed identity: minted random
 * namespaces, deterministic SHA-256 derivations, recompute stability, index
 * bounds, and the shared safe-component grammar.
 */

import { describe, expect, it } from "vitest";
import {
  assertAttemptId, assertBrokerRequestId, assertGateProofId, assertHandoffId,
  assertPhaseInstanceId, assertPreparationId, assertPreparationRunId,
  assertSafeComponent, deriveAttemptId, deriveBrokerRequestId, deriveGateProofId,
  deriveHandoffId, derivePhaseInstanceId, mapExpansionIdentity, mintPreparationId,
  mintPreparationRunId, repeatExpansionIdentity, singleExpansionIdentity,
} from "../../src/preparations/ids.js";
import { PreparationIdentityError } from "../../src/preparations/problems.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("minted preparation identities", () => {
  it("mints and re-validates lowercase random namespaces", () => {
    const preparation = mintPreparationId();
    expect(preparation).toMatch(/^prp_[0-9a-f]{32}$/);
    expect(assertPreparationId(preparation)).toBe(preparation);
    expect(assertPreparationRunId(mintPreparationRunId())).toMatch(/^prr_[0-9a-f]{32}$/);
  });

  it("rejects wrong prefix, case, and length", () => {
    expect(() => assertPreparationId(`prr_${"a".repeat(32)}`)).toThrow(PreparationIdentityError);
    expect(() => assertPreparationId(`prp_${"A".repeat(32)}`)).toThrow(PreparationIdentityError);
    expect(() => assertPreparationId(`prp_${"a".repeat(31)}`)).toThrow(PreparationIdentityError);
  });
});

describe("derived preparation identities", () => {
  const phase = derivePhaseInstanceId({ manifestDigest: DIGEST, logicalPhaseId: "collect", expansionIdentity: singleExpansionIdentity() });

  it("derives a stable, recomputable phase-instance identity", () => {
    const again = derivePhaseInstanceId({ manifestDigest: DIGEST, logicalPhaseId: "collect", expansionIdentity: "single" });
    expect(phase).toBe(again);
    expect(assertPhaseInstanceId(phase)).toMatch(/^phi_[0-9a-f]{64}$/);
  });

  it("changes the identity when any component changes", () => {
    const other = derivePhaseInstanceId({ manifestDigest: DIGEST, logicalPhaseId: "expand", expansionIdentity: "single" });
    expect(other).not.toBe(phase);
  });

  it("derives attempt, broker, gate, and handoff identities", () => {
    const attempt = deriveAttemptId(phase, 0);
    expect(assertAttemptId(attempt)).toMatch(/^pat_[0-9a-f]{64}$/);
    expect(assertBrokerRequestId(deriveBrokerRequestId(attempt, 1))).toMatch(/^brq_[0-9a-f]{64}$/);
    const run = mintPreparationRunId();
    const gate = deriveGateProofId({ runId: run, gateId: "review", planDigest: DIGEST, decisionIndex: 0 });
    expect(assertGateProofId(gate)).toBe(gate);
    const handoff = deriveHandoffId(run, DIGEST);
    expect(assertHandoffId(handoff)).toBe(handoff);
  });

  it("rejects an out-of-range derivation index", () => {
    expect(() => deriveAttemptId(phase, -1)).toThrow(PreparationIdentityError);
    expect(() => deriveAttemptId(phase, 1_000_000)).toThrow(PreparationIdentityError);
  });
});

describe("safe component grammar and expansion identities", () => {
  it("accepts safe components and rejects unsafe ones", () => {
    expect(assertSafeComponent("collect-1")).toBe("collect-1");
    for (const unsafe of ["", "a/b", "..", ".hidden", "x".repeat(200)]) {
      expect(() => assertSafeComponent(unsafe)).toThrow(PreparationIdentityError);
    }
  });

  it("builds distinct canonical expansion identities", () => {
    expect(repeatExpansionIdentity(2)).toBe("repeat-2");
    expect(mapExpansionIdentity("abc")).toBe("map-abc");
    expect(singleExpansionIdentity()).toBe("single");
  });
});
