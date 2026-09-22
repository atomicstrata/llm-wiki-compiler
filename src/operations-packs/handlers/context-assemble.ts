/**
 * @file src/operations-packs/handlers/context-assemble.ts
 * @description The context-assemble host-handler family (design section 16.2): a
 * PURE, deterministic selection of immutable input evidence under declared
 * eligibility, stable ordering, and finite item/byte/token budgets. It reads only
 * the evidence passed to it, invokes no provider, and NEVER writes. Ineligible
 * items are filtered into the visible excluded set; over-budget items are truncated
 * in stable order into the excluded set and counted as ONE completeness deficit, so
 * the caller always sees exactly which identities were dropped and why.
 *
 * RESOLVED FROM PROSE (section 16.2). Eligibility reads two declared item fields —
 * `evidenceClass` against the body's declared classes and `contentTier` against its
 * declared tiers — and the deterministic order is (declared-tier rank, then itemId).
 * Budgets read the declared `bytes` and `tokenCost` fields; the ordering policy id
 * is recorded as authored while the concrete order stays a stable total order.
 */

import { enforceOutputBytes, stableSortByKey } from "./evidence.js";
import type {
  ContextPhaseBodyV2,
} from "../recipe-types.js";
import type {
  PackContextInputV1, PackContextItemV1, PackContextResultV1,
  PackEvidenceItemV1, PackExclusionV1,
} from "./types.js";

const EVIDENCE_CLASS_FIELD = "evidenceClass";
const CONTENT_TIER_FIELD = "contentTier";
const BYTE_FIELD = "bytes";
const TOKEN_FIELD = "tokenCost";
const CONTEXT_COMPLETENESS_CLASS = "context-assembly";

/** The numeric budget cost one item draws against a declared context budget. */
function numericField(item: PackEvidenceItemV1, field: string): number {
  const value = item.fields[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Classify one item's eligibility against the declared classes and tiers (16.2). */
function eligibility(item: PackEvidenceItemV1, body: ContextPhaseBodyV2): "ok" | PackExclusionV1["reason"] {
  if (!body.evidenceClasses.includes(String(item.fields[EVIDENCE_CLASS_FIELD]))) return "ineligible-class";
  if (!body.contentTiers.includes(String(item.fields[CONTENT_TIER_FIELD]))) return "ineligible-tier";
  return "ok";
}

/** The stable order key of one eligible item: declared-tier rank, then itemId. */
function orderKey(item: PackEvidenceItemV1, body: ContextPhaseBodyV2): string {
  const rank = body.contentTiers.indexOf(String(item.fields[CONTENT_TIER_FIELD]));
  return `${String(rank).padStart(6, "0")}:${item.itemId}`;
}

/** Split items into eligible (stably ordered) and the ineligible excluded set. */
function partitionEligible(input: PackContextInputV1): { eligible: PackEvidenceItemV1[]; excluded: PackExclusionV1[] } {
  const eligible: PackEvidenceItemV1[] = [];
  const excluded: PackExclusionV1[] = [];
  for (const item of input.evidence) {
    const verdict = eligibility(item, input.body);
    if (verdict === "ok") eligible.push(item);
    else excluded.push({ itemId: item.itemId, reason: verdict });
  }
  return { eligible: stableSortByKey(eligible, (item) => orderKey(item, input.body)), excluded };
}

/** True while admitting one more item keeps every declared budget satisfied. */
function fitsBudgets(body: ContextPhaseBodyV2, used: { items: number; bytes: number; tokens: number }, item: PackEvidenceItemV1): PackExclusionV1["reason"] | "ok" {
  if (used.items + 1 > body.itemBudget) return "over-item-budget";
  if (used.bytes + numericField(item, BYTE_FIELD) > body.byteBudget) return "over-byte-budget";
  if (used.tokens + numericField(item, TOKEN_FIELD) > body.tokenBudget) return "over-token-budget";
  return "ok";
}

/** Admit eligible items in order while their declared budgets hold (section 16.2). */
function admitWithinBudgets(eligible: readonly PackEvidenceItemV1[], body: ContextPhaseBodyV2): { included: PackContextItemV1[]; excluded: PackExclusionV1[]; bytes: number; tokens: number } {
  const used = { items: 0, bytes: 0, tokens: 0 };
  const included: PackContextItemV1[] = [];
  const excluded: PackExclusionV1[] = [];
  for (const item of eligible) {
    const verdict = fitsBudgets(body, used, item);
    if (verdict !== "ok") { excluded.push({ itemId: item.itemId, reason: verdict }); continue; }
    used.items += 1; used.bytes += numericField(item, BYTE_FIELD); used.tokens += numericField(item, TOKEN_FIELD);
    included.push({ itemId: item.itemId, evidenceClass: String(item.fields[EVIDENCE_CLASS_FIELD]), contentTier: String(item.fields[CONTENT_TIER_FIELD]) });
  }
  return { included, excluded, bytes: used.bytes, tokens: used.tokens };
}

/**
 * Assemble bounded, stably ordered context evidence with a visible included and
 * excluded identity set (section 16.2). Pure and deterministic: identical input
 * yields identical output bytes. It reads only the passed evidence and never writes.
 */
export function assembleContext(input: PackContextInputV1): PackContextResultV1 {
  const { eligible, excluded: ineligible } = partitionEligible(input);
  const admitted = admitWithinBudgets(eligible, input.body);
  const excluded = [...ineligible, ...admitted.excluded];
  const deficits = admitted.excluded.length === 0 ? [] : [{ completenessClass: CONTEXT_COMPLETENESS_CLASS, reason: "overflow" as const, droppedCount: admitted.excluded.length }];
  const result: PackContextResultV1 = {
    eligibilityPolicyId: input.body.eligibilityPolicyId, orderingPolicyId: input.body.orderingPolicyId,
    items: admitted.included, itemCount: admitted.included.length, byteCount: admitted.bytes, tokenCount: admitted.tokens,
    selection: { included: admitted.included.map((item) => item.itemId), excluded }, deficits,
  };
  enforceOutputBytes(result, input.bounds.maximumOutputBytes);
  return result;
}
