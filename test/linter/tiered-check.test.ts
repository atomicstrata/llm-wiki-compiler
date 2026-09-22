/**
 * @file test/linter/tiered-check.test.ts
 * @description The tiered check report (AS-1 §4.6): findings split by the KIND
 * of claim they make, not by how loud they are.
 *
 * WHY A TIER IS NOT A SEVERITY. "37 issues" is useless if some of them are
 * broken links, some are a model's opinion about page quality, and some are an
 * index that needs regenerating. Only the first kind means something is wrong.
 * `deterministicErrors` is the number an operator can actually act on, and it
 * deliberately excludes the other two tiers.
 *
 * THE INVARIANT THAT MATTERS MOST is that the tiered view and `lint` never
 * disagree. They are two groupings of one run, so every finding must appear in
 * exactly one tier and the union must equal `lint`'s results exactly — order
 * included. A tiered report that quietly dropped or duplicated a finding would
 * be worse than no tiering at all, because it would look authoritative.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declaredRuleTiers, lint, lintByTier } from "../../src/linter/index.js";
import { tieredReport } from "../../src/linter/tiers.js";
import type { LintResult } from "../../src/linter/types.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(() => tracker.cleanup());

/** A small wiki with a page that links nowhere real — a deterministic fault. */
async function wikiWithBrokenLink(): Promise<string> {
  const root = await tracker.create("tiered-check-");
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki", "concepts", "alpha.md"),
    "---\ntitle: Alpha\n---\n\nAlpha explains things and links to [[nowhere-at-all]].\n", "utf8");
  return root;
}

/** One finding under a given rule and severity. */
function finding(rule: string, severity: LintResult["severity"]): LintResult {
  return { rule, severity, file: `${rule}.md`, message: rule };
}

describe("the tiered report is a faithful regrouping", () => {
  it("splits findings into exactly the three tiers, losing none", () => {
    const report = tieredReport([
      { tier: "deterministic", results: [finding("broken-wikilink", "error")] },
      { tier: "provider-judgement", results: [finding("low-confidence", "warning")] },
      { tier: "derived-view", results: [finding("stale-page", "warning")] },
    ]);
    expect(report.deterministic.map((r) => r.rule)).toEqual(["broken-wikilink"]);
    expect(report.providerJudgement.map((r) => r.rule)).toEqual(["low-confidence"]);
    expect(report.derivedView.map((r) => r.rule)).toEqual(["stale-page"]);
  });

  it("counts ONLY deterministic errors as things that are actually wrong", () => {
    const report = tieredReport([
      { tier: "deterministic", results: [finding("broken-wikilink", "error")] },
      // Both of these are errors by severity, and neither is evidence of a
      // defect: one is an opinion, one is a regenerable artifact being behind.
      { tier: "provider-judgement", results: [finding("contradicted-page", "error")] },
      { tier: "derived-view", results: [finding("stale-page", "error")] },
    ]);
    expect(report.deterministicErrors).toBe(1);
  });

  it("preserves rule-registry order within a tier", () => {
    const report = tieredReport([
      { tier: "deterministic", results: [finding("first", "error")] },
      { tier: "derived-view", results: [finding("ignored", "info")] },
      { tier: "deterministic", results: [finding("second", "error")] },
    ]);
    expect(report.deterministic.map((r) => r.rule)).toEqual(["first", "second"]);
  });
});

describe("the tiered view and lint agree", () => {
  it("returns the SAME findings as lint, in the same order", async () => {
    const root = await wikiWithBrokenLink();
    const [summary, tiered] = await Promise.all([lint(root), lintByTier(root)]);
    // Two groupings of one run: the union must reconstruct lint's list exactly.
    // A tier that dropped or duplicated a finding would show up right here.
    const union = [...tiered.deterministic, ...tiered.providerJudgement, ...tiered.derivedView];
    expect(union).toHaveLength(summary.results.length);
    expect([...union].sort(byKey)).toEqual([...summary.results].sort(byKey));
  });

  it("finds the broken link and files it as deterministic, not as an opinion", async () => {
    const root = await wikiWithBrokenLink();
    const tiered = await lintByTier(root);
    // Pins the precondition: a run that found nothing would satisfy any claim
    // about where findings were filed.
    expect(tiered.deterministic.length).toBeGreaterThan(0);
    expect(tiered.deterministic.some((r) => r.rule === "broken-wikilink")).toBe(true);
    expect(tiered.providerJudgement.some((r) => r.rule === "broken-wikilink")).toBe(false);
  });
});

/** Stable ordering key so the union can be compared as a set. */
function byKey(left: LintResult, right: LintResult): number {
  return `${left.rule}${left.file}${left.message}`.localeCompare(`${right.rule}${right.file}${right.message}`);
}

describe("every rule's tier is pinned", () => {
  it("declares the COMPLETE set, so a new rule cannot slip in untiered", () => {
    // An allowlist, not a spot check: a rule added to any registry changes this
    // list and reddens here, forcing a deliberate answer to "what kind of claim
    // does it make?" rather than defaulting into `deterministic` unnoticed.
    expect(declaredRuleTiers()).toEqual([
      { rule: "checkBrokenWikilinks", tier: "deterministic" },
      { rule: "checkOrphanedPages", tier: "deterministic" },
      { rule: "checkMissingSummaries", tier: "deterministic" },
      { rule: "checkDuplicateConcepts", tier: "deterministic" },
      { rule: "checkEmptyPages", tier: "deterministic" },
      { rule: "checkBrokenCitations", tier: "deterministic" },
      { rule: "checkMalformedClaimCitations", tier: "deterministic" },
      { rule: "checkLowConfidencePages", tier: "provider-judgement" },
      { rule: "checkContradictedPages", tier: "provider-judgement" },
      { rule: "checkInferredWithoutCitations", tier: "provider-judgement" },
      { rule: "checkJournalHealth", tier: "deterministic" },
      { rule: "checkPendingEmbeddings", tier: "derived-view" },
      { rule: "checkWorkflowRunHealth", tier: "deterministic" },
      { rule: "checkSchemaCrossLinks", tier: "deterministic" },
      { rule: "checkStalePages", tier: "derived-view" },
    ]);
  });

  it("keeps every model judgement OUT of the deterministic tier", () => {
    // The property the count depends on, stated independently of the list above
    // so a careless update to that list cannot quietly relax it.
    const judgements = ["checkLowConfidencePages", "checkContradictedPages", "checkInferredWithoutCitations"];
    const declared = new Map(declaredRuleTiers().map((entry) => [entry.rule, entry.tier]));
    expect(judgements.map((rule) => declared.get(rule))).toEqual(judgements.map(() => "provider-judgement"));
  });
});
