/**
 * @file test/preparations/task7-blockers.test.ts
 * @description Regressions for the four Wave O3 Task 7 host-authority blockers,
 * each written from the adversarial repro that exploited it. Every case here
 * PASSED before the uniform-capture remediation — an accessor downgrading a
 * required class, an array-like forging the whole completeness record, a stored
 * source-evidence list diverging from the digested one, and a decision named
 * after an `Object.prototype` member leaking a function into a compiled
 * Milestone A resolution.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  CompletenessAuthorityError, assertCompletenessPermitsSuccess, deriveCompleteness,
} from "../../src/preparations/completeness.js";
import { normalizeProviderProposals, ProposalAuthorityError } from "../../src/preparations/proposals.js";
import {
  RESOLUTION_BY_DECISION, ReconciliationAuthorityError, resolutionForDecision,
} from "../../src/preparations/reconciliation.js";
import { IntentCompilerError } from "../../src/preparations/intent-compiler.js";
import {
  ATTEMPT, PROVIDER_PIN, baseRequest, compiler, contract, evidence, identitySetRef, proposals, sets,
} from "./task7-fixture.js";
import type { EvidenceRefV1 } from "../../src/preparations/types.js";
import type { PreparationReconciliationV1 } from "../../src/preparations/reconciliation.js";

describe("T7-B1 a disposition accessor cannot downgrade a required class", () => {
  it("refuses a class input whose disposition is read a second time as optional", () => {
    let reads = 0;
    const hostileClass = {
      classId: "critical", identitySetRef,
      get disposition(): "required" | "optional" {
        reads += 1;
        return reads === 1 ? "required" : "optional";
      },
      identitySets: sets({
        planned: ["a", "b", "c"], eligible: ["a", "b", "c"], attempted: ["a", "b", "c"],
        failed: ["a", "b", "c"],
      }),
    };
    expect(() => deriveCompleteness({ scopeId: "s", classes: [hostileClass] }))
      .toThrow(CompletenessAuthorityError);
  });

  it("keeps three failed required identities a blocking required deficit", () => {
    const derived = deriveCompleteness({
      scopeId: "s", classes: [{
        classId: "critical", disposition: "required", identitySetRef,
        identitySets: sets({
          planned: ["a", "b", "c"], eligible: ["a", "b", "c"], attempted: ["a", "b", "c"],
          failed: ["a", "b", "c"],
        }),
      }],
    });
    expect(derived.record.requiredDeficitCount).toBe(3);
    expect(() => assertCompletenessPermitsSuccess(derived.record)).toThrow(CompletenessAuthorityError);
  });
});

describe("T7-B2 the class container is captured, never trusted", () => {
  it("refuses an array-like carrying its own map in place of the class list", () => {
    const forgedCounters = {
      classId: "entity-facts", disposition: "required" as const, identitySetRef,
      planned: 100, eligible: 0, attempted: 0, completed: 0, included: 0, skipped: 0,
      unavailable: 0, failed: 0, cancelled: 0, overflow: 0, nonConverged: 0,
    };
    const hostile = {
      length: 1,
      map: (): unknown[] => Array.from({ length: 500 }, (_, index) => ({
        counters: { ...forgedCounters, classId: `forged-${index}` }, sets: {}, deficits: [],
      })),
    };
    expect(() => deriveCompleteness({ scopeId: "s", classes: hostile as never }))
      .toThrow(CompletenessAuthorityError);
  });

  it("enforces the class cap on a real array of class inputs", () => {
    const classes = Array.from({ length: 65 }, (_, index) => ({
      classId: `class-${index}`, disposition: "optional" as const, identitySetRef,
      identitySets: sets(),
    }));
    try {
      deriveCompleteness({ scopeId: "s", classes });
      throw new Error("expected a class-cap refusal");
    } catch (error) {
      expect((error as CompletenessAuthorityError).code).toBe("class-cap-exceeded");
    }
  });
});

describe("T7-B3 stored source evidence is the digested source evidence", () => {
  it("refuses a source-evidence accessor that answers differently on a later read", () => {
    const shown: EvidenceRefV1 = { ...evidence, digest: parseSha256Digest(`sha256:${"a".repeat(64)}`) };
    const digested: EvidenceRefV1 = { ...evidence, digest: parseSha256Digest(`sha256:${"b".repeat(64)}`) };
    let reads = 0;
    const input = {
      contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN,
      drafts: [{ proposalKind: "entity-fact", proposedValue: 1 }],
      get sourceEvidenceRefs(): readonly EvidenceRefV1[] {
        reads += 1;
        return reads === 3 ? [digested] : [shown];
      },
    };
    expect(() => normalizeProviderProposals(input)).toThrow(ProposalAuthorityError);
  });

  it("binds provenance to exactly the evidence the proposal carries", () => {
    const only = normalizeProviderProposals({
      contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN,
      sourceEvidenceRefs: [{ ...evidence, digest: parseSha256Digest(`sha256:${"b".repeat(64)}`) }],
      drafts: [{ proposalKind: "entity-fact", proposedValue: 1 }],
    });
    const other = normalizeProviderProposals({
      contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN,
      sourceEvidenceRefs: [{ ...evidence, digest: parseSha256Digest(`sha256:${"a".repeat(64)}`) }],
      drafts: [{ proposalKind: "entity-fact", proposedValue: 1 }],
    });
    expect(only[0]!.sourceEvidenceRefs[0]!.digest).toBe(`sha256:${"b".repeat(64)}`);
    expect(only[0]!.provenanceDigest).not.toBe(other[0]!.provenanceDigest);
  });
});

describe("T7-B4 the resolution table cannot return an inherited member", () => {
  it("gives the table a null prototype so no Object.prototype member is reachable", () => {
    expect(Object.getPrototypeOf(RESOLUTION_BY_DECISION)).toBe(null);
    expect((RESOLUTION_BY_DECISION as unknown as Record<string, unknown>).toString).toBeUndefined();
    expect((RESOLUTION_BY_DECISION as unknown as Record<string, unknown>).constructor).toBeUndefined();
  });

  it("refuses a decision outside the closed six-value vocabulary", () => {
    for (const forged of ["toString", "constructor", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(() => resolutionForDecision(forged)).toThrow(ReconciliationAuthorityError);
    }
    expect(resolutionForDecision("accept")).toBe("create-distinct");
    expect(resolutionForDecision("defer")).toBeUndefined();
  });

  it("refuses to compile a reconciliation whose decision names a prototype member", () => {
    const forged: PreparationReconciliationV1 = {
      schemaVersion: 1, reconciliationId: "r", proposalIds: [proposals[0]!.proposalId],
      decision: "toString" as never, policyDigest: `sha256:${"1".repeat(64)}` as never,
      reasonCodes: ["duplicate-entity"], evidenceRefs: [],
    };
    expect(() => compiler.compile(baseRequest({ reconciliations: [forged] })))
      .toThrow(IntentCompilerError);
  });
});
