/**
 * Wiki linter orchestrator.
 *
 * Imports all lint rules, runs them concurrently, and aggregates
 * results into a summary with error/warning/info counts.
 * This is the main entry point for programmatic lint access.
 */

import type { LintResult, LintRule, LintSummary, SchemaAwareLintRule } from "./types.js";
import {
  checkBrokenWikilinks,
  checkOrphanedPages,
  checkMissingSummaries,
  checkDuplicateConcepts,
  checkEmptyPages,
  checkBrokenCitations,
  checkMalformedClaimCitations,
  checkLowConfidencePages,
  checkContradictedPages,
  checkInferredWithoutCitations,
  checkSchemaCrossLinks,
  checkStalePages,
} from "./rules.js";
import { checkJournalHealth } from "./journal-rule.js";
import { checkPendingEmbeddings } from "./pending-embeddings-rule.js";
import { checkWorkflowRunHealth } from "./workflow-run-rule.js";
import { loadSchema } from "../schema/index.js";
import { buildFreshnessSnapshot } from "../freshness/index.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { loadProfile } from "../profile/load.js";
import {
  groupByDeclaredTier, tieredReport, type LintTierV1, type TieredLintReportV1, type TieredResultGroupV1,
} from "./tiers.js";
import { collectProfileLintFindings, collectProfileLintInput } from "../profile/lint.js";
import type { PageScope } from "./rules-shared.js";

/** Rule-only lint checks that don't depend on the schema layer. */
/**
 * Every rule with the KIND of claim it makes (section §4.6 tiering).
 *
 * The tier sits beside the function rather than in a lookup keyed by rule id,
 * because rule ids are computed in places (`profile/${kind}`) and a table keyed
 * by them could never be proven complete. Ordering is load-bearing: `lint`
 * flattens these in registry order and suites pin that output byte-for-byte.
 */
const RULES_WITHOUT_SCHEMA: ReadonlyArray<{ rule: LintRule; tier: LintTierV1 }> = [
  { rule: checkBrokenWikilinks, tier: "deterministic" },
  { rule: checkOrphanedPages, tier: "deterministic" },
  { rule: checkMissingSummaries, tier: "deterministic" },
  { rule: checkDuplicateConcepts, tier: "deterministic" },
  { rule: checkEmptyPages, tier: "deterministic" },
  { rule: checkBrokenCitations, tier: "deterministic" },
  { rule: checkMalformedClaimCitations, tier: "deterministic" },
  // A model's assessment of a page, not a fact about it.
  { rule: checkLowConfidencePages, tier: "provider-judgement" },
  { rule: checkContradictedPages, tier: "provider-judgement" },
  { rule: checkInferredWithoutCitations, tier: "provider-judgement" },
  { rule: checkJournalHealth, tier: "deterministic" },
  // Embeddings not yet computed: a derived view is behind, nothing is wrong.
  { rule: checkPendingEmbeddings, tier: "derived-view" },
  { rule: checkWorkflowRunHealth, tier: "deterministic" },
];

/** Lint rules that need the resolved schema to know per-kind expectations. */
const RULES_WITH_SCHEMA: ReadonlyArray<{ rule: SchemaAwareLintRule; tier: LintTierV1 }> = [
  { rule: checkSchemaCrossLinks, tier: "deterministic" },
];

type FreshnessLintRule = (root: string, snapshot: FreshnessSnapshot) => Promise<LintResult[]>;
const RULES_WITH_FRESHNESS: ReadonlyArray<{ rule: FreshnessLintRule; tier: LintTierV1 }> = [
  // A page whose sources moved on: regenerating fixes it.
  { rule: checkStalePages, tier: "derived-view" },
];

/**
 * Count occurrences of a specific severity level in the results.
 */
function countBySeverity(
  results: LintResult[],
  severity: LintResult["severity"],
): number {
  return results.filter((r) => r.severity === severity).length;
}

/** Build a summary from a flat result list, computing the severity counts. */
function summarize(results: LintResult[]): LintSummary {
  return {
    errors: countBySeverity(results, "error"),
    warnings: countBySeverity(results, "warning"),
    info: countBySeverity(results, "info"),
    results,
  };
}

/**
 * Append profile-aware entity findings when the project runs a NON-default
 * profile. A default/built-in profile (`loadedFrom === null`) returns the
 * default results UNCHANGED, so the default lint output stays byte-identical.
 */
async function profileGroups(root: string, defaultResults: readonly LintResult[]): Promise<TieredResultGroupV1[]> {
  const { profile, loadedFrom } = await loadProfile(root);
  if (loadedFrom === null) return [];
  // One entity collection feeds every profile check, including the declared
  // numeric confidence judgement, so a tiered view never walks entities twice.
  const collected = await collectProfileLintFindings(await collectProfileLintInput(root, profile));
  // Only an overlapping default confidence finding wins; unrelated duplicates survive.
  const defaultConfidenceFiles = new Set(
    defaultResults.filter((r) => r.rule === "low-confidence").map((r) => r.file),
  );
  const results = collected.results.filter((r) => r.rule !== "low-confidence" || !defaultConfidenceFiles.has(r.file));
  // Profile rule ids are declared beside their emitters; grouping preserves the
  // emission order and refuses any id nobody declared.
  return groupByDeclaredTier(results, collected.ruleTiers);
}

/**
 * Run every registered rule once, keeping each rule's results paired with the
 * tier its registry entry declared.
 *
 * ORDER IS THE CONTRACT. `lint` flattens these groups in exactly the order the
 * registries and the profile appendix produce them, which is the order the
 * frozen parity suites pin — so this must never sort or regroup.
 */
async function collectTieredGroups(root: string, scope: PageScope = "generic"): Promise<TieredResultGroupV1[]> {
  const schema = await loadSchema(root);
  const freshness = await buildFreshnessSnapshot(root);
  const [plain, schemaGroups, freshnessGroups] = await Promise.all([
    Promise.all(RULES_WITHOUT_SCHEMA.map(async (entry) => ({
      tier: entry.tier,
      results: await (entry.rule === checkBrokenWikilinks ? checkBrokenWikilinks(root, scope) : entry.rule(root)),
    }))),
    Promise.all(RULES_WITH_SCHEMA.map(async (entry) => ({ tier: entry.tier, results: await entry.rule(root, schema) }))),
    Promise.all(RULES_WITH_FRESHNESS.map(async (entry) => ({ tier: entry.tier, results: await entry.rule(root, freshness) }))),
  ]);
  const defaultResults = [...plain, ...schemaGroups, ...freshnessGroups];
  return [...defaultResults, ...await profileGroups(root, defaultResults.flatMap((group) => group.results))];
}

/**
 * Run all lint rules concurrently against the wiki at the given root.
 * Loads the project schema (or defaults) so schema-aware rules can enforce
 * per-kind cross-link minimums alongside structural checks. When the project
 * declares a NON-default profile, profile-aware entity findings are appended;
 * a default profile leaves the output byte-identical to the pre-profile linter.
 * @param root - Absolute path to the project root directory.
 * @returns A summary containing all diagnostics and severity counts.
 */
export async function lint(root: string): Promise<LintSummary> {
  // lint is intentionally not journaled to log.md — it is a read-only check,
  // and the MCP `lint_wiki` tool documents it as non-mutating.
  return summarize((await collectTieredGroups(root)).flatMap((group) => group.results));
}

/**
 * The same check, split by the KIND of claim each finding makes (§4.6).
 *
 * Same rules, same order, same findings as {@link lint} — only the grouping
 * differs, so the two can never disagree about what is wrong with a wiki.
 * Read-only, like `lint`.
 *
 * @param root - Absolute path to the project root directory.
 * @returns Findings split into deterministic, provider-judgement and derived-view.
 */
/**
 * Every registered rule with the tier its registry entry declares.
 *
 * EXPOSED SO A CONTROL CAN PIN THE COMPLETE SET. Mis-tiering is silent by
 * nature — a model's judgement filed as `deterministic` makes
 * {@link TieredLintReportV1.deterministicErrors} claim a wiki is broken when it
 * only holds an opinion — and no behavioural test catches it, because the rule
 * still runs and still reports. The label is the rule FUNCTION's own name, so
 * the list is derived from the registry rather than hand-written beside it and
 * a newly registered rule shows up here without anyone remembering to add it.
 *
 * @returns One entry per registered rule, in registry order.
 */
export function declaredRuleTiers(): ReadonlyArray<{ rule: string; tier: LintTierV1 }> {
  return [...RULES_WITHOUT_SCHEMA, ...RULES_WITH_SCHEMA, ...RULES_WITH_FRESHNESS]
    .map((entry) => ({ rule: entry.rule.name, tier: entry.tier }));
}

export async function lintByTier(root: string): Promise<TieredLintReportV1> {
  return tieredReport(await collectTieredGroups(root));
}

/**
 * Both views of ONE run: the flat summary and the tiered report.
 *
 * A caller that needs both — the CLI writes the summary to the lint cache and
 * prints the tiers — would otherwise run every rule twice, and two runs of a
 * filesystem check can legitimately disagree if the tree changes between them.
 *
 * @param root - Absolute path to the project root directory.
 */
export async function lintBothViews(
  root: string,
  scope: PageScope = "generic",
): Promise<{ summary: LintSummary; tiered: TieredLintReportV1 }> {
  const groups = await collectTieredGroups(root, scope);
  return { summary: summarize(groups.flatMap((group) => group.results)), tiered: tieredReport(groups) };
}
