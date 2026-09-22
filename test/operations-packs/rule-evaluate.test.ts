/**
 * @file test/operations-packs/rule-evaluate.test.ts
 * @description rule-evaluate (design section 16.4) applies only REGISTERED rules at
 * their exact version, supplies parameters only through each rule's closed schema
 * (a missing, unknown, wrong-typed, or out-of-range parameter fails closed), reads
 * the host clock for freshness windows, produces stable deterministic findings, and
 * fails closed when the evidence set exceeds the item ceiling.
 */

import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../src/operations-packs/handlers/rule-evaluate.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { PackHostHandlerError } from "../../src/operations-packs/handlers/types.js";
import type { ValidatePhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackEvidenceItemV1, PackRuleInputV1 } from "../../src/operations-packs/handlers/types.js";

const NOW = "2026-08-14T00:00:00.000Z";
function item(itemId: string, fields: PackEvidenceItemV1["fields"]): PackEvidenceItemV1 { return { itemId, fields }; }
function input(body: ValidatePhaseBodyV2, evidence: PackEvidenceItemV1[], maximumItems = 100): PackRuleInputV1 {
  return { body, evidence, clock: { now: () => NOW }, bounds: { maximumItems, maximumOutputBytes: 262_144 } };
}

describe("rule-evaluate", () => {
  it("evaluates registered rules into stable findings deterministically", () => {
    const body: ValidatePhaseBodyV2 = { ruleBindings: [
      { ruleId: "min-field-count", ruleVersion: "1.0.0", parameters: [{ paramId: "minimum", value: 1 }] },
      { ruleId: "unique-identity", ruleVersion: "1.0.0", parameters: [] },
    ] };
    const evidence = [item("a", { title: "x" }), item("b", {}), item("a", { title: "y" })];
    const first = evaluateRules(input(body, evidence));
    expect(canonicalBytes(first)).toEqual(canonicalBytes(evaluateRules(input(body, evidence))));
    expect(first.findings).toContainEqual({ ruleId: "min-field-count", code: "below-min-field-count", itemId: "b" });
    expect(first.findings).toContainEqual({ ruleId: "unique-identity", code: "duplicate-identity", itemId: "a" });
  });

  it("refuses an unregistered rule id and a drifted rule version", () => {
    const unknown: ValidatePhaseBodyV2 = { ruleBindings: [{ ruleId: "made-up", ruleVersion: "1.0.0", parameters: [] }] };
    const drifted: ValidatePhaseBodyV2 = { ruleBindings: [{ ruleId: "unique-identity", ruleVersion: "2.0.0", parameters: [] }] };
    expect(() => evaluateRules(input(unknown, []))).toThrow(PackHostHandlerError);
    expect(() => evaluateRules(input(drifted, []))).toThrow(PackHostHandlerError);
  });

  it("enforces the rule's closed parameter schema", () => {
    const rule = (parameters: ValidatePhaseBodyV2["ruleBindings"][number]["parameters"]): ValidatePhaseBodyV2 =>
      ({ ruleBindings: [{ ruleId: "min-field-count", ruleVersion: "1.0.0", parameters }] });
    const wrongType = rule([{ paramId: "minimum", value: true }]);
    const unknownParam = rule([{ paramId: "minimum", value: 1 }, { paramId: "extra", value: 2 }]);
    const missing = rule([]);
    for (const body of [wrongType, unknownParam, missing]) expect(() => evaluateRules(input(body, []))).toThrow(PackHostHandlerError);
  });

  it("flags stale items against the host clock freshness window", () => {
    const body: ValidatePhaseBodyV2 = { ruleBindings: [{ ruleId: "freshness-window", ruleVersion: "1.0.0", parameters: [{ paramId: "maxAgeDays", value: 7 }] }] };
    const evidence = [item("fresh", { updatedAt: "2026-08-10T00:00:00.000Z" }), item("stale", { updatedAt: "2026-01-01T00:00:00.000Z" })];
    expect(evaluateRules(input(body, evidence)).findings).toEqual([{ ruleId: "freshness-window", code: "stale", itemId: "stale" }]);
  });

  it("fails closed when the evidence set exceeds the item ceiling", () => {
    const body: ValidatePhaseBodyV2 = { ruleBindings: [] };
    expect(() => evaluateRules(input(body, [item("a", {}), item("b", {})], 1))).toThrow(PackHostHandlerError);
  });
});
