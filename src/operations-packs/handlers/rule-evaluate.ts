/**
 * @file src/operations-packs/handlers/rule-evaluate.ts
 * @description The rule-evaluate host-handler family (design section 16.4): a
 * PURE application of a CLOSED registered rule set to bounded typed evidence. Every
 * rule id, version, and parameter schema is host registered here; a pack supplies
 * parameters only through that rule's closed schema, so an unregistered rule id, a
 * drifted rule version, an unknown parameter, or a wrong-typed/out-of-range
 * parameter all fail closed. No pack-authored string parameter can reach a rule —
 * those are refused upstream — so a rule parameter is always a bounded number or
 * boolean, and no new algorithm, comparator, or model judgment is representable.
 *
 * RESOLVED FROM PROSE (section 16.4). The launch rule family is `min-field-count`
 * (schema/required-field breadth), `freshness-window` (a declared freshness window
 * over the host clock), `unique-identity` (identity/duplicate integrity), and
 * `no-empty-values` (value presence). Findings are emitted in a stable
 * (ruleId, itemId, code) order; the evidence set must fit the item ceiling.
 */

import { capItems, enforceOutputBytes, stableSortByKey } from "./evidence.js";
import { PackHostHandlerError } from "./types.js";
import type { RuleBindingV2 } from "../recipe-types.js";
import type {
  PackEvidenceItemV1, PackHostClockV1, PackRuleFindingV1, PackRuleInputV1, PackRuleResultV1,
} from "./types.js";

const MS_PER_DAY = 86_400_000;

/** One closed parameter a registered rule accepts, with its type and range. */
interface RuleParamSpecV1 {
  readonly paramId: string;
  readonly kind: "number" | "boolean";
  readonly minimum?: number;
}

/** One registered rule: its version, closed parameter schema, and evaluator. */
interface RuleSpecV1 {
  readonly version: string;
  readonly params: readonly RuleParamSpecV1[];
  readonly evaluate: (evidence: readonly PackEvidenceItemV1[], params: ReadonlyMap<string, number | boolean>, clock: PackHostClockV1) => PackRuleFindingV1[];
}

/** Flag items whose declared field count falls below the required minimum. */
function minFieldCount(evidence: readonly PackEvidenceItemV1[], params: ReadonlyMap<string, number | boolean>): PackRuleFindingV1[] {
  const minimum = params.get("minimum") as number;
  return evidence
    .filter((item) => Object.keys(item.fields).length < minimum)
    .map((item) => ({ ruleId: "min-field-count", code: "below-min-field-count", itemId: item.itemId }));
}

/** Flag items whose `updatedAt` is missing, unparseable, or beyond the window. */
function freshnessWindow(evidence: readonly PackEvidenceItemV1[], params: ReadonlyMap<string, number | boolean>, clock: PackHostClockV1): PackRuleFindingV1[] {
  const maxAgeDays = params.get("maxAgeDays") as number;
  const now = Date.parse(clock.now());
  return evidence.flatMap((item) => freshnessFinding(item, maxAgeDays, now));
}

/** The freshness finding for one item, or none when it is within the window. */
function freshnessFinding(item: PackEvidenceItemV1, maxAgeDays: number, now: number): PackRuleFindingV1[] {
  const raw = item.fields.updatedAt;
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return [{ ruleId: "freshness-window", code: "missing-timestamp", itemId: item.itemId }];
  if (now - parsed > maxAgeDays * MS_PER_DAY) return [{ ruleId: "freshness-window", code: "stale", itemId: item.itemId }];
  return [];
}

/** Flag every item whose itemId duplicates an earlier item's identity. */
function uniqueIdentity(evidence: readonly PackEvidenceItemV1[]): PackRuleFindingV1[] {
  const seen = new Set<string>();
  const findings: PackRuleFindingV1[] = [];
  for (const item of evidence) {
    if (seen.has(item.itemId)) findings.push({ ruleId: "unique-identity", code: "duplicate-identity", itemId: item.itemId });
    else seen.add(item.itemId);
  }
  return findings;
}

/** Flag items carrying any empty-string field value. */
function noEmptyValues(evidence: readonly PackEvidenceItemV1[]): PackRuleFindingV1[] {
  return evidence
    .filter((item) => Object.values(item.fields).some((value) => value === ""))
    .map((item) => ({ ruleId: "no-empty-values", code: "empty-value", itemId: item.itemId }));
}

/** The closed registered rule set (section 16.4); ids outside it fail closed. */
const RULES: Readonly<Record<string, RuleSpecV1>> = {
  "min-field-count": { version: "1.0.0", params: [{ paramId: "minimum", kind: "number", minimum: 0 }], evaluate: minFieldCount },
  "freshness-window": { version: "1.0.0", params: [{ paramId: "maxAgeDays", kind: "number", minimum: 0 }], evaluate: freshnessWindow },
  "unique-identity": { version: "1.0.0", params: [], evaluate: uniqueIdentity },
  "no-empty-values": { version: "1.0.0", params: [], evaluate: noEmptyValues },
};

/** Resolve one registered rule spec or fail closed on an unknown id/version. */
function resolveRule(binding: RuleBindingV2): RuleSpecV1 {
  const spec = RULES[binding.ruleId];
  if (spec === undefined) throw new PackHostHandlerError(`rule is not registered: ${binding.ruleId}`);
  if (spec.version !== binding.ruleVersion) throw new PackHostHandlerError(`rule version drift for ${binding.ruleId}`);
  return spec;
}

/** Validate one supplied parameter against its closed spec and return its value. */
function readParam(binding: RuleBindingV2, spec: RuleParamSpecV1): number | boolean {
  const supplied = binding.parameters.find((parameter) => parameter.paramId === spec.paramId);
  if (supplied === undefined) throw new PackHostHandlerError(`rule ${binding.ruleId} is missing parameter ${spec.paramId}`);
  const value = supplied.value;
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") throw new PackHostHandlerError(`rule ${binding.ruleId} parameter ${spec.paramId} is the wrong type`);
    return value;
  }
  if (typeof value !== "number") throw new PackHostHandlerError(`rule ${binding.ruleId} parameter ${spec.paramId} is the wrong type`);
  if (spec.minimum !== undefined && value < spec.minimum) throw new PackHostHandlerError(`rule ${binding.ruleId} parameter ${spec.paramId} is out of range`);
  return value;
}

/** Resolve every declared parameter through the rule's closed schema, no extras. */
function resolveParams(binding: RuleBindingV2, spec: RuleSpecV1): ReadonlyMap<string, number | boolean> {
  const allowed = new Set(spec.params.map((param) => param.paramId));
  const unknown = binding.parameters.find((parameter) => !allowed.has(parameter.paramId));
  if (unknown !== undefined) throw new PackHostHandlerError(`rule ${binding.ruleId} rejects unknown parameter ${unknown.paramId}`);
  return new Map(spec.params.map((param) => [param.paramId, readParam(binding, param)]));
}

/** The stable (ruleId, itemId, code) order key for one finding. */
function findingKey(finding: PackRuleFindingV1): string {
  return `${finding.ruleId}:${finding.itemId ?? ""}:${finding.code}`;
}

/**
 * Apply the registered rule bindings to bounded typed evidence, producing stable
 * findings (section 16.4). Pure and deterministic: identical input and clock yield
 * identical output bytes. It never writes. An evidence set beyond the item ceiling
 * fails closed before any rule runs.
 */
export function evaluateRules(input: PackRuleInputV1): PackRuleResultV1 {
  capItems(input.evidence, input.bounds.maximumItems, { kind: "fail" });
  const findings = input.body.ruleBindings.flatMap((binding) => {
    const spec = resolveRule(binding);
    return spec.evaluate(input.evidence, resolveParams(binding, spec), input.clock);
  });
  const result: PackRuleResultV1 = {
    evaluatedRuleIds: input.body.ruleBindings.map((binding) => binding.ruleId),
    findings: stableSortByKey(findings, findingKey),
    deficits: [],
  };
  enforceOutputBytes(result, input.bounds.maximumOutputBytes);
  return result;
}
