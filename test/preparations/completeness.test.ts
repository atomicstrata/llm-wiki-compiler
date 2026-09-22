/**
 * @file test/preparations/completeness.test.ts
 * @description Host-owned completeness authority (design section 19): the eleven
 * closed identity categories, their containment and partition equations, counters
 * DERIVED from the sets rather than trusted from any provider, required deficits
 * that block success, optional deficits that produce exact warnings, map overflow,
 * repeat non-convergence, and a changed eligibility universe.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  COMPLETENESS_CATEGORIES, COMPLETION_CLASS_IDENTITY_KEYS, CompletenessAuthorityError,
  PROVIDER_COUNT_MISMATCH_CODE, assertCompletenessPermitsSuccess, assertIdentitySetEquations,
  captureIdentitySets, compareProviderCompletionClaim, deriveCompleteness,
  toRunCompletenessRecord, toRunCompletionWarning, type CompletionClassInputV1,
} from "../../src/preparations/completeness.js";
import type { EvidenceRefV1 } from "../../src/preparations/types.js";

const identitySetRef: EvidenceRefV1 = {
  kind: "completeness-identity-set", mediaType: "application/json", provenanceLabel: "host-derived",
  digest: parseSha256Digest(`sha256:${"a".repeat(64)}`), byteCount: 128, sensitivity: "ordinary", retention: "audit",
  producer: { kind: "host", contractDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`) }, untrusted: true,
};

type SetOverrides = Partial<Record<string, unknown>>;

/** Build one identity-set record: three planned ids, one included, one overflow. */
function sets(overrides: SetOverrides = {}): Record<string, unknown> {
  return {
    planned: ["a", "b", "c"], eligible: ["a", "b"], attempted: ["a", "b"], completed: ["a"],
    included: ["a"], skipped: ["b"], unavailable: [], failed: [], cancelled: [],
    overflow: ["c"], nonConverged: [], ...overrides,
  };
}

/** Build one class input, defaulting to a required class over the shared sets. */
function classInput(overrides: Partial<CompletionClassInputV1> = {}): CompletionClassInputV1 {
  return {
    classId: "screened-sources", disposition: "required", identitySetRef,
    identitySets: sets(), ...overrides,
  };
}

/** Derive completeness over one class and return the whole derivation. */
function derive(input: CompletionClassInputV1 = classInput()) {
  return deriveCompleteness({ scopeId: "phase-collect", classes: [input] });
}

/** Assert that deriving over the given sets fails closed with the exact code. */
function expectCode(overrides: SetOverrides, code: string): void {
  try {
    derive(classInput({ identitySets: sets(overrides) }));
    throw new Error("expected a completeness refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(CompletenessAuthorityError);
    expect((error as CompletenessAuthorityError).code).toBe(code);
  }
}

describe("preparation completeness identity sets", () => {
  it("closes the category vocabulary to the exact eleven design categories", () => {
    expect([...COMPLETENESS_CATEGORIES]).toEqual([
      "planned", "eligible", "attempted", "completed", "included", "skipped",
      "unavailable", "failed", "cancelled", "overflow", "nonConverged",
    ]);
  });

  it("classifies every completion-class field so none can escape the counters", () => {
    const derived = derive().record.classes[0]!;
    expect(Object.keys(derived).sort()).toEqual(
      [...COMPLETION_CLASS_IDENTITY_KEYS, ...COMPLETENESS_CATEGORIES].sort(),
    );
    const overlap = COMPLETION_CLASS_IDENTITY_KEYS.filter(
      (key) => (COMPLETENESS_CATEGORIES as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it("derives every counter from the exact set sizes", () => {
    const derived = derive().record.classes[0]!;
    expect(derived.planned).toBe(3);
    expect(derived.eligible).toBe(2);
    expect(derived.completed).toBe(1);
    expect(derived.included).toBe(1);
    expect(derived.skipped).toBe(1);
    expect(derived.overflow).toBe(1);
  });

  it("canonicalizes each captured category and validates the equations directly", () => {
    const captured = captureIdentitySets(sets({ planned: ["c", "a", "b"] }));
    expect(captured.planned).toEqual(["a", "b", "c"]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => assertIdentitySetEquations(captured)).not.toThrow();
    expect(() => assertIdentitySetEquations(captureIdentitySets(sets({ included: ["b"] }))))
      .toThrowError(CompletenessAuthorityError);
  });

  it("rejects a duplicated identity inside one category", () => {
    expectCode({ planned: ["a", "a", "b", "c"] }, "duplicate-identity");
  });

  it("rejects two outcome categories that overlap on one identity", () => {
    expectCode({ failed: ["a"] }, "categories-overlap");
  });

  it("rejects an identity-set record that omits a category", () => {
    const partial = sets();
    delete partial.cancelled;
    try {
      derive(classInput({ identitySets: partial }));
      throw new Error("expected a completeness refusal");
    } catch (error) {
      expect((error as CompletenessAuthorityError).code).toBe("missing-category");
    }
  });

  it("rejects a provider counter smuggled in as an extra category key", () => {
    expectCode({ completedCount: 99 }, "unknown-category");
  });

  it("requires the outcome categories to exactly cover the eligible set", () => {
    expectCode({ skipped: [] }, "outcome-coverage-mismatch");
  });

  it("requires each nested category to be contained by its parent", () => {
    expectCode({ included: ["b"] }, "set-not-contained");
  });

  it("rejects an overflow identity that was also materialized as eligible", () => {
    expectCode({ overflow: ["a"] }, "overflow-materialized");
  });
});

describe("preparation completeness deficits", () => {
  it("blocks terminal success while a required deficit exists", () => {
    const derived = derive();
    expect(derived.record.requiredDeficitCount).toBe(2);
    expect(() => assertCompletenessPermitsSuccess(derived.record)).toThrowError(CompletenessAuthorityError);
  });

  it("produces an exact optional warning and permits success", () => {
    const derived = derive(classInput({ disposition: "optional" }));
    expect(derived.record.requiredDeficitCount).toBe(0);
    expect(derived.record.optionalDeficitCount).toBe(2);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]!.deficitIdentities).toEqual(["b", "c"]);
    expect(derived.deficits["screened-sources"]).toEqual(["b", "c"]);
    expect(() => assertCompletenessPermitsSuccess(derived.record)).not.toThrow();
  });

  it("counts map overflow into the declared class without aliasing it", () => {
    const derived = derive(classInput({ disposition: "optional" })).record.classes[0]!;
    expect(derived.overflow).toBe(1);
    expect(derived.skipped).toBe(1);
    expect(derived.failed).toBe(0);
    expect(derived.unavailable).toBe(0);
  });

  it("counts a non-converged repeat as its own deficit, never as converged work", () => {
    const nonConverged = sets({
      planned: ["a", "b"], eligible: ["a", "b"], attempted: ["a", "b"], completed: ["a"],
      included: ["a"], skipped: [], overflow: [], nonConverged: ["b"],
    });
    const derived = derive(classInput({ identitySets: nonConverged })).record.classes[0]!;
    expect(derived.nonConverged).toBe(1);
    expect(derived.completed).toBe(1);
    expect(derived.skipped).toBe(0);
    expect(derived.failed).toBe(0);
    expect(derived.cancelled).toBe(0);
  });

  it("never aliases an unavailable identity to skipped or a cancelled one to failed", () => {
    const mixed = sets({
      planned: ["a", "b", "c"], eligible: ["a", "b", "c"], attempted: ["a", "b", "c"],
      completed: ["a"], included: ["a"], skipped: [], unavailable: ["b"], cancelled: ["c"],
      overflow: [],
    });
    const derived = derive(classInput({ identitySets: mixed })).record.classes[0]!;
    expect([derived.unavailable, derived.skipped, derived.cancelled, derived.failed]).toEqual([1, 0, 1, 0]);
  });
});

describe("preparation completeness is host-derived only", () => {
  it("ignores a provider completion claim and reports the mismatch as a notice", () => {
    const derived = derive();
    const notices = compareProviderCompletionClaim({
      claim: { completed: 99, included: 99, planned: 3 }, derived: derived.record,
    });
    expect(derived.record.classes[0]!.completed).toBe(1);
    expect(notices.map((notice) => notice.code)).toEqual([PROVIDER_COUNT_MISMATCH_CODE]);
  });

  it("emits no notice when a provider claim happens to agree with the host sets", () => {
    const derived = derive();
    const notices = compareProviderCompletionClaim({
      claim: { planned: 3, completed: 1, included: 1 }, derived: derived.record,
    });
    expect(notices).toEqual([]);
  });

  it("changes the identity-set digest when the eligibility universe changes", () => {
    const before = derive().record;
    const after = derive(classInput({
      identitySets: sets({ eligible: ["a"], attempted: ["a"], skipped: [], overflow: ["b", "c"] }),
    })).record;
    expect(after.identitySetsDigest).not.toBe(before.identitySetsDigest);
    expect(after.scopeDigest).toBe(before.scopeDigest);
  });

  it("projects onto the landed run completeness and warning records", () => {
    const derived = derive(classInput({ disposition: "optional" }));
    expect(toRunCompletenessRecord(derived.record)).toEqual({
      requiredDeficit: 0, optionalDeficit: 2, classDigest: derived.record.identitySetsDigest,
    });
    expect(toRunCompletionWarning(derived.warnings[0]!)).toEqual({
      code: "preparation-optional-completeness-deficit", attempted: 2, completed: 1, skipped: 1, failed: 0,
    });
  });
});
