/**
 * Wiki linter orchestrator.
 *
 * Imports all lint rules, runs them concurrently, and aggregates
 * results into a summary with error/warning/info counts.
 * This is the main entry point for programmatic lint access.
 *
 * The run has ONE body, {@link collectTieredGroupsFrom}, over the lint sources
 * of `lint-sources.ts`. It names no project root. `lint`, `lintByTier` and
 * `lintBothViews` build the local-disk sources from their root and are views
 * of that one body; `lintFrom` and `lintBothViewsFrom` are the same views for
 * a caller that already holds sources.
 */

import type { LintResult, LintRule, LintSummary, SchemaAwareLintRule } from "./types.js";
import {
  checkBrokenWikilinks, checkBrokenWikilinksFrom,
  checkOrphanedPages, checkOrphanedPagesFrom,
  checkMissingSummaries, checkMissingSummariesFrom,
  checkDuplicateConcepts, checkDuplicateConceptsFrom,
  checkEmptyPages, checkEmptyPagesFrom,
  checkBrokenCitations,
  checkMalformedClaimCitations,
  checkLowConfidencePages, checkLowConfidencePagesFrom,
  checkContradictedPages, checkContradictedPagesFrom,
  checkInferredWithoutCitations, checkInferredWithoutCitationsFrom,
  checkSchemaCrossLinks,
  checkStalePages, checkStalePagesFrom,
} from "./rules.js";
import { checkBrokenCitationsFrom, checkMalformedClaimCitationsFrom } from "./rules-citations.js";
import { checkSchemaCrossLinksFrom } from "./rules-crosslinks.js";
import { checkJournalHealth, checkJournalHealthFrom } from "./journal-rule.js";
import { checkPendingEmbeddings, checkPendingEmbeddingsFrom } from "./pending-embeddings-rule.js";
import { checkWorkflowRunHealth, checkWorkflowRunHealthFrom } from "./workflow-run-rule.js";
import { diskLintSources, type LintSources } from "./lint-sources.js";
import { loadSchemaFrom, type SchemaConfig } from "../schema/index.js";
import { buildFreshnessSnapshotFrom } from "../freshness/index.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { loadProfileFrom } from "../profile/load.js";
import { readStateClassifiedFrom } from "../utils/state.js";
import {
  groupByDeclaredTier, tieredReport, type LintTierV1, type TieredLintReportV1, type TieredResultGroupV1,
} from "./tiers.js";
import { collectProfileLintFindings, collectProfileLintInputFrom } from "../profile/lint.js";
import { readOncePageSources, type PageScope } from "./rules-shared.js";

/**
 * One registry entry. `rule` is the root-taking rule: its function NAME is the
 * entry's label in {@link declaredRuleTiers}, and the run does not call it.
 * `from` is what the run calls: the same rule's one body, handed the members
 * of the lint sources it reads through and whatever else its registry passes.
 */
interface Registered<Rule, Extra extends unknown[]> {
  rule: Rule;
  from: (sources: LintSources, ...extra: Extra) => Promise<LintResult[]>;
  tier: LintTierV1;
}

/** Rule-only lint checks that don't depend on the schema layer. */
/**
 * Every rule with the KIND of claim it makes (section §4.6 tiering).
 *
 * The tier sits beside the function rather than in a lookup keyed by rule id,
 * because rule ids are computed in places (`profile/${kind}`) and a table keyed
 * by them could never be proven complete. Ordering is load-bearing: `lint`
 * flattens these in registry order and suites pin that output byte-for-byte.
 *
 * Every entry is handed the run's page scope; ONLY the broken-wikilink entry
 * passes it on. Every other rule walks the generic pages, as before.
 */
const RULES_WITHOUT_SCHEMA: ReadonlyArray<Registered<LintRule, [scope: PageScope]>> = [
  { rule: checkBrokenWikilinks, from: ({ pages, candidates }, scope) => checkBrokenWikilinksFrom({ pages, candidates }, scope), tier: "deterministic" },
  { rule: checkOrphanedPages, from: ({ pages }) => checkOrphanedPagesFrom(pages), tier: "deterministic" },
  { rule: checkMissingSummaries, from: ({ pages }) => checkMissingSummariesFrom(pages), tier: "deterministic" },
  { rule: checkDuplicateConcepts, from: ({ pages }) => checkDuplicateConceptsFrom(pages), tier: "deterministic" },
  { rule: checkEmptyPages, from: ({ pages }) => checkEmptyPagesFrom(pages), tier: "deterministic" },
  { rule: checkBrokenCitations, from: ({ pages, cited }) => checkBrokenCitationsFrom({ pages, cited }), tier: "deterministic" },
  { rule: checkMalformedClaimCitations, from: ({ pages }) => checkMalformedClaimCitationsFrom(pages), tier: "deterministic" },
  // A model's assessment of a page, not a fact about it.
  { rule: checkLowConfidencePages, from: ({ pages }) => checkLowConfidencePagesFrom(pages), tier: "provider-judgement" },
  { rule: checkContradictedPages, from: ({ pages }) => checkContradictedPagesFrom(pages), tier: "provider-judgement" },
  { rule: checkInferredWithoutCitations, from: ({ pages }) => checkInferredWithoutCitationsFrom(pages), tier: "provider-judgement" },
  { rule: checkJournalHealth, from: ({ journal }) => checkJournalHealthFrom(journal), tier: "deterministic" },
  // Embeddings not yet computed: a derived view is behind, nothing is wrong.
  { rule: checkPendingEmbeddings, from: ({ embeddings }) => checkPendingEmbeddingsFrom(embeddings), tier: "derived-view" },
  { rule: checkWorkflowRunHealth, from: ({ workflows }) => checkWorkflowRunHealthFrom(workflows), tier: "deterministic" },
];

/** Lint rules that need the resolved schema to know per-kind expectations. */
const RULES_WITH_SCHEMA: ReadonlyArray<Registered<SchemaAwareLintRule, [schema: SchemaConfig]>> = [
  { rule: checkSchemaCrossLinks, from: ({ pages }, schema) => checkSchemaCrossLinksFrom(pages, schema), tier: "deterministic" },
];

type FreshnessLintRule = (root: string, snapshot: FreshnessSnapshot) => Promise<LintResult[]>;
const RULES_WITH_FRESHNESS: ReadonlyArray<Registered<FreshnessLintRule, [snapshot: FreshnessSnapshot]>> = [
  // A page whose sources moved on: regenerating fixes it.
  { rule: checkStalePages, from: ({ pages }, snapshot) => checkStalePagesFrom(pages, snapshot), tier: "derived-view" },
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
async function profileGroupsFrom(sources: LintSources, defaultResults: readonly LintResult[]): Promise<TieredResultGroupV1[]> {
  const { profile, loadedFrom } = await loadProfileFrom(sources.profile);
  if (loadedFrom === null) return [];
  // One entity collection feeds every profile check, including the declared
  // numeric confidence judgement, so a tiered view never walks entities twice.
  const collected = await collectProfileLintFindings(await collectProfileLintInputFrom(sources.entities, profile));
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
 *
 * THE ONE BODY, over {@link LintSources}. In order: the schema; the compile
 * state and then the freshness snapshot built from it; every registered rule,
 * started together in registry order; and last the profile appendix. Nothing a
 * rule reads is shared with another rule or kept for a later step.
 */
async function collectTieredGroupsFrom(allSources: LintSources, scope: PageScope): Promise<TieredResultGroupV1[]> {
  const sources = { ...allSources, pages: readOncePageSources(allSources.pages) };
  const schema = await loadSchemaFrom(sources.schema);
  const freshness = await buildFreshnessSnapshotFrom(sources.sourceFreshness, await readStateClassifiedFrom(sources.state));
  const [plain, schemaGroups, freshnessGroups] = await Promise.all([
    Promise.all(RULES_WITHOUT_SCHEMA.map(async (entry) => ({ tier: entry.tier, results: await entry.from(sources, scope) }))),
    Promise.all(RULES_WITH_SCHEMA.map(async (entry) => ({ tier: entry.tier, results: await entry.from(sources, schema) }))),
    Promise.all(RULES_WITH_FRESHNESS.map(async (entry) => ({ tier: entry.tier, results: await entry.from(sources, freshness) }))),
  ]);
  const defaultResults = [...plain, ...schemaGroups, ...freshnessGroups];
  return [...defaultResults, ...await profileGroupsFrom(sources, defaultResults.flatMap((group) => group.results))];
}

/** LOCAL DISK. {@link collectTieredGroupsFrom} for the project at `root`. */
async function collectTieredGroups(root: string, scope: PageScope = "generic"): Promise<TieredResultGroupV1[]> {
  return collectTieredGroupsFrom(diskLintSources(root), scope);
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
  return lintFrom(diskLintSources(root));
}

/**
 * {@link lint} over {@link LintSources}: the flat summary of one run of the one
 * body, under the generic page scope, with no project root. It builds no tiered
 * report.
 *
 * @param sources - What the run reads through.
 * @returns A summary containing all diagnostics and severity counts.
 */
export async function lintFrom(sources: LintSources): Promise<LintSummary> {
  // lint is intentionally not journaled to log.md — it is a read-only check,
  // and the MCP `lint_wiki` tool documents it as non-mutating.
  return summarize((await collectTieredGroupsFrom(sources, "generic")).flatMap((group) => group.results));
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
  return lintBothViewsFrom(diskLintSources(root), scope);
}

/**
 * {@link lintBothViews} over {@link LintSources}: both views of one run of the
 * one body, with no project root.
 *
 * @param sources - What the run reads through.
 * @param scope - The page scope the broken-wikilink rule walks.
 */
export async function lintBothViewsFrom(
  sources: LintSources,
  scope: PageScope = "generic",
): Promise<{ summary: LintSummary; tiered: TieredLintReportV1 }> {
  const groups = await collectTieredGroupsFrom(sources, scope);
  return { summary: summarize(groups.flatMap((group) => group.results)), tiered: tieredReport(groups) };
}
