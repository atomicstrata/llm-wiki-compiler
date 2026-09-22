/**
 * @file src/linter/tiers.ts
 * @description The three kinds of thing a wiki check can find, and why they
 * must not be reported as one list (AutoSci AS-1 §4.6 `check`).
 *
 * SEVERITY IS NOT TIER, which is the whole reason this exists. `error` and
 * `warning` say how loud a finding is; a tier says what KIND of claim it makes,
 * and therefore what an operator can conclude from it. A broken wikilink is a
 * fact — the target is not there. A low-confidence page is a model's opinion,
 * and a reasonable person may disagree with it. A stale index is neither wrong
 * nor disputed; it is simply out of date and regenerating fixes it. Mixing the
 * three produces a report where "37 issues" means nothing, because a reader
 * cannot tell how many are actually broken.
 *
 * THE TIER IS DECLARED AT THE REGISTRY, NOT LOOKED UP FROM A RULE ID. Rule ids
 * are open-ended — `profile/${problem.kind}` and other computed values reach the
 * output — so a hand-written id-to-tier table could not be complete and would
 * silently drop any rule nobody remembered to add. Pairing the tier with the
 * rule FUNCTION where rules are registered makes an untiered rule a type error
 * instead of a missing row.
 *
 * THIS ADDS NO FIELD TO {@link LintResult}. Several suites pin the default lint
 * output as byte-identical, so the tier is a VIEW over results grouped by the
 * rule that produced them, never a property stamped onto them.
 */

import type { LintResult } from "./types.js";

/**
 * What kind of claim a rule makes.
 *
 * - `deterministic` — a fact the checker can prove: a link resolves or it does
 *   not. Actionable without judgement, and the only tier where a count is a
 *   count of things that are definitely wrong.
 * - `provider-judgement` — a model's assessment. Worth reading, never
 *   authoritative, and never grounds for failing a build on its own.
 * - `derived-view` — a regenerable artifact is out of date. Not a defect in the
 *   knowledge, and fixed by regenerating rather than by editing.
 */
export type LintTierV1 = "deterministic" | "provider-judgement" | "derived-view";

/** One rule's results, carrying the tier the registry declared for that rule. */
export interface TieredResultGroupV1 {
  readonly tier: LintTierV1;
  readonly results: LintResult[];
}

/** A whole check, split by the kind of claim each finding makes. */
export interface TieredLintReportV1 {
  readonly deterministic: readonly LintResult[];
  readonly providerJudgement: readonly LintResult[];
  readonly derivedView: readonly LintResult[];
  /**
   * The count that answers "is my wiki broken?" — deterministic errors only.
   * A provider's opinion and a stale index are deliberately excluded: neither
   * is evidence that anything is wrong.
   */
  readonly deterministicErrors: number;
}

/** Collect one tier's findings, preserving rule-registry order. */
function ofTier(groups: readonly TieredResultGroupV1[], tier: LintTierV1): LintResult[] {
  return groups.filter((group) => group.tier === tier).flatMap((group) => group.results);
}

/**
 * Split tiered rule output into the report §4.6 describes.
 *
 * @param groups - Each rule's results paired with its registry-declared tier.
 */
export function tieredReport(groups: readonly TieredResultGroupV1[]): TieredLintReportV1 {
  const deterministic = ofTier(groups, "deterministic");
  return {
    deterministic,
    providerJudgement: ofTier(groups, "provider-judgement"),
    derivedView: ofTier(groups, "derived-view"),
    deterministicErrors: deterministic.filter((result) => result.severity === "error").length,
  };
}
