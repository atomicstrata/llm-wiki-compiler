/**
 * Pure declarations for profile lint, expressed in the linter's tier vocabulary
 * (`LintTierV1`). Structural IDs share the collector's closed problem union;
 * store IDs come from their actual check groups. Declared numeric confidence
 * interprets a stored judgment and never invokes a model, so it is filed as
 * `provider-judgement`; everything else the profile pass emits is a fact.
 */
import type { EntityProblemKind } from "./collect.js";
import type { ProfilePack } from "./types.js";
import type { LintResult } from "../linter/types.js";
import type { LintTierV1 } from "../linter/tiers.js";
import { RELATION_LINT_RULES } from "./relation-lint.js";
import { EVENT_LINT_RULES } from "./event-lint.js";
import { ARTIFACT_LINT_RULES } from "./artifact-lint.js";
import { EMPTY_PAGE_RULE } from "../linter/rules.js";
import { MALFORMED_CLAIM_CITATION_RULE } from "../linter/rules-citations.js";

/** One rule id the profile pass can emit, with the kind of claim it makes. */
export interface ProfileRuleTier { rule: string; tier: LintTierV1 }

/** Exhaustive severity table also supplies the emitted structural rule suffixes. */
export const PROBLEM_SEVERITY: Record<EntityProblemKind, LintResult["severity"]> = {
  "invalid-directory": "error",
  "non-slug-safe-filename": "error",
  "slug-mismatch": "error",
  "field-violation": "warning",
};

/** Shared emitted lifecycle ID. */
export const INVALID_LIFECYCLE_STATE_RULE = "invalid-lifecycle-state";

/** Rules run by the profile collection, independent of whether pages exist. */
export function profileRuleTiers(profile: ProfilePack): ProfileRuleTier[] {
  const rules = [
    ...Object.keys(PROBLEM_SEVERITY).map((kind) => `profile/${kind}`),
    EMPTY_PAGE_RULE, MALFORMED_CLAIM_CITATION_RULE, INVALID_LIFECYCLE_STATE_RULE,
    ...RELATION_LINT_RULES, ...EVENT_LINT_RULES, ...ARTIFACT_LINT_RULES,
  ];
  const descriptors: ProfileRuleTier[] = rules.map((rule) => ({ rule, tier: "deterministic" }));
  if (Object.values(profile.entities).some((def) => def.fields?.confidence?.type === "number")) {
    descriptors.push({ rule: "low-confidence", tier: "provider-judgement" });
  }
  return descriptors;
}
