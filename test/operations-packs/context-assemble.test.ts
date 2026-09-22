/**
 * @file test/operations-packs/context-assemble.test.ts
 * @description context-assemble (design section 16.2) admits eligible evidence in
 * stable declared-tier order deterministically, filters ineligible class/tier into
 * the visible excluded set, and truncates over-budget items into the excluded set
 * with a counted completeness deficit (a declared deficit, not a silent drop).
 */

import { describe, expect, it } from "vitest";
import { assembleContext } from "../../src/operations-packs/handlers/context-assemble.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import type { ContextPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackContextInputV1, PackEvidenceItemV1 } from "../../src/operations-packs/handlers/types.js";

function item(itemId: string, evidenceClass: string, contentTier: string, bytes = 10, tokenCost = 5): PackEvidenceItemV1 {
  return { itemId, fields: { evidenceClass, contentTier, bytes, tokenCost } };
}

function input(evidence: PackEvidenceItemV1[], over: Partial<ContextPhaseBodyV2> = {}): PackContextInputV1 {
  const body: ContextPhaseBodyV2 = {
    eligibilityPolicyId: "policy.default", contentTiers: ["primary", "secondary"], evidenceClasses: ["source", "entity"],
    itemBudget: 10, byteBudget: 1000, tokenBudget: 1000, orderingPolicyId: "stable", ...over,
  };
  return { body, evidence, bounds: { maximumItems: 100, maximumOutputBytes: 262_144 } };
}

describe("context-assemble", () => {
  it("assembles eligible items in stable tier order, deterministically", () => {
    const evidence = [item("b", "source", "secondary"), item("a", "source", "primary"), item("x", "unknown", "primary"), item("y", "entity", "tertiary")];
    const first = assembleContext(input(evidence));
    expect(canonicalBytes(first)).toEqual(canonicalBytes(assembleContext(input(evidence))));
    expect(first.items.map((entry) => entry.itemId)).toEqual(["a", "b"]);
    expect(first.selection.excluded).toEqual(expect.arrayContaining([
      { itemId: "x", reason: "ineligible-class" }, { itemId: "y", reason: "ineligible-tier" },
    ]));
  });

  it("truncates over-item-budget items into the excluded set with a deficit", () => {
    const evidence = [item("a", "source", "primary"), item("b", "source", "primary"), item("c", "source", "primary")];
    const result = assembleContext(input(evidence, { itemBudget: 2 }));
    expect(result.items.map((entry) => entry.itemId)).toEqual(["a", "b"]);
    expect(result.selection.excluded).toEqual([{ itemId: "c", reason: "over-item-budget" }]);
    expect(result.deficits).toEqual([{ completenessClass: "context-assembly", reason: "overflow", droppedCount: 1 }]);
  });

  it("excludes items that would exceed the byte budget", () => {
    const evidence = [item("a", "source", "primary", 600), item("b", "source", "primary", 600)];
    const result = assembleContext(input(evidence, { byteBudget: 1000 }));
    expect(result.items.map((entry) => entry.itemId)).toEqual(["a"]);
    expect(result.selection.excluded).toEqual([{ itemId: "b", reason: "over-byte-budget" }]);
  });
});
