/**
 * @file test/storage/eval-health-binding.test.ts
 * @description The health score and the per-page health distribution as WHOLE
 * consumers with no project directory: `evaluateHealthFrom` and
 * `evaluatePageHealthDistributionFrom` over `LintSources`, and under both the
 * findings `runAllLintRulesFrom` hands them. They exist only
 * after the two evaluators were given sources of their own, so this file has
 * NO before-edit run.
 *
 * HOW IT IS BUILT. One default-profile project is minted on real disk: a page
 * with one broken link and one link to a page awaiting review, two pages with
 * the same title, a contradicted page, a low-confidence page and a clean page.
 * The real candidate writer stages the awaited page, and one malformed file is
 * planted beside it. The real root-taking evaluators answer: the raw findings
 * of `runAllLintRules(root)`, the health score, and the distribution with the
 * default, 2, 0 and -1 worst pages. The tree is
 * copied as raw text and listings and the directory is removed before any case
 * runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The real lint coordinator with every rule, the
 * real tolerant candidate list and count, the deductions, the clamp, the page
 * walk, the grouping, the tiers, the top issues and the sort. No finding, count
 * or page list is handed in.
 *
 * WHAT IS NOT SHOWN. A score clamped at zero, a custom profile, a stale page,
 * and the two evaluators' callers: `runEval`, the SDK and the MCP tools still
 * take a root and are not run here. The doubles are those of
 * `lint-sources-doubles.ts` plus a candidate directory read from the copy. They
 * are not a store and show nothing about confinement on disk.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { evaluateHealth, evaluateHealthFrom, runAllLintRules, runAllLintRulesFrom } from "../../src/eval/health.js";
import { evaluatePageHealthDistribution, evaluatePageHealthDistributionFrom } from "../../src/eval/page-health-distribution.js";
import type { HealthResult, PageHealthDistributionResult } from "../../src/eval/types.js";
import type { LintSources } from "../../src/linter/lint-sources.js";
import type { LintResult } from "../../src/linter/types.js";
import { CANDIDATES_DIR, CONCEPTS_DIR, SOURCES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { countOf, expectRemovedDefaultCopies, heldText, mintCopied, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { lintSourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";

const PREFIX = "eval-health-";
const ALPHA = `${CONCEPTS_DIR}/alpha.md`;
const CITED = "This body is long enough to count as a page and it cites its source. ^[a.md]";
/** One page with a summary, any further frontmatter lines, and a cited body. */
const page = (title: string, moreFront = "", body = CITED): string => `---\ntitle: ${title}\nsummary: A summary.\n${moreFront}---\n\n${body}\n`;
const FILES: Record<string, string> = {
  [ALPHA]: page("Alpha", "", "Alpha is long enough to count as a page and links to [[Missing Page]] and [[Queued Thing]]. ^[a.md]"),
  [`${CONCEPTS_DIR}/twin-a.md`]: page("Twin Title"),
  [`${CONCEPTS_DIR}/twin-b.md`]: page("Twin Title"),
  [`${CONCEPTS_DIR}/disputed.md`]: page("Disputed", "contradictedBy: [twin-a]\n"),
  [`${CONCEPTS_DIR}/shaky.md`]: page("Shaky", "confidence: 0.2\n"),
  [`${CONCEPTS_DIR}/fine.md`]: page("Fine"),
  [`${SOURCES_DIR}/a.md`]: "A source.\n",
};
/** How often one default lint run reads each page: once, shared by every rule that walks the pages. */
const LINT_PAGE_READS = 1;

/** What the disk evaluators answered. */
interface OnDisk {
  real: string;
  findings: LintResult[];
  health: HealthResult;
  pages: PageHealthDistributionResult;
  worstTwo: PageHealthDistributionResult;
  worstNone: PageHealthDistributionResult;
  worstMinusOne: PageHealthDistributionResult;
}

const tracker = tempRootTracker();
let project: Minted<OnDisk>;

/** The pages, one pending candidate staged by the real writer, and one malformed candidate file beside it. */
async function seed(root: string): Promise<void> {
  await writeFiles(root, FILES);
  await writeCandidate(root, { title: "Queued", summary: "Queued", sources: [], body: "Queued body.", slug: "queued-thing" });
  await writeFiles(root, { [`${CANDIDATES_DIR}/malformed.json`]: "{" });
}

/** Ask the real root-taking evaluators every way this suite compares. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  return {
    real: root, findings: await runAllLintRules(root),
    health: await evaluateHealth(root), pages: await evaluatePageHealthDistribution(root),
    worstTwo: await evaluatePageHealthDistribution(root, 2), worstNone: await evaluatePageHealthDistribution(root, 0),
    worstMinusOne: await evaluatePageHealthDistribution(root, -1),
  };
}

mintOnceThenRemove(tracker, async () => { project = await mintCopied(tracker, PREFIX, seed, askedOnDisk); });

/** The candidate directories over the copy. Each directory look is logged; `refuseFirst` rejects the FIRST look only. */
function candidatesOver(events: string[], refuseFirst?: Error): LintSources["candidates"] {
  let looks = 0;
  return {
    directory: async (relDir) => {
      looks += 1;
      events.push(`candidates ${relDir}`);
      if (refuseFirst !== undefined && looks === 1) throw refuseFirst;
      const entries = project.copy.listings.get(relDir);
      return entries === undefined ? null : { exists: async () => true, listEntries: async () => entries };
    },
    leaf: async (relDir, fileName) => ({ location: `memory:${fileName}`, readText: async () => heldText(project.copy, `${relDir}/${fileName}`) }),
  };
}

/** Every lint source over the copy, with the candidates read from the copy too. */
function sourcesOver(events: string[], over: Partial<LintSources> = {}): LintSources {
  return lintSourcesOver(project, events, NO_ENTITIES, { candidates: candidatesOver(events), ...over });
}

const ruleOf = (health: HealthResult, rule: string): unknown[] => health.rules.filter((one) => one.rule === rule).map((one) => [one.count, one.deduction]);
const entryOf = (result: PageHealthDistributionResult, slug: string): unknown => result.perPage.find((one) => one.slug === slug);

describe("the health score over a copied project, with the directory gone", () => {
  it("H1 runs after the minting directory was removed, on a copy that holds the staged candidate and the malformed file", () => {
    expectRemovedDefaultCopies([project], PREFIX);
    expect(project.copy.files.has(`${CANDIDATES_DIR}/malformed.json`)).toBe(true);
    expect(project.onDisk.health.pendingReviews).toBe(1);
  });

  it("H1b hands on the findings the root-taking form found on disk: the same findings, in the same order, each once", async () => {
    const findings = await runAllLintRulesFrom(sourcesOver([]));
    expect(findings).toEqual(project.onDisk.findings);
    expect(findings.map((one) => [one.rule, path.relative(project.dir, one.file), one.severity]).slice(0, 2)).toEqual([
      ["broken-wikilink", ALPHA, "error"], ["pending-target", ALPHA, "info"],
    ]);
    // The score and the distribution are built from exactly these findings, no more and no fewer.
    expect(findings).toHaveLength(project.onDisk.health.rules.reduce((sum, one) => sum + one.count, 0));
    expect(new Set(findings.map((one) => one.file)).size).toBe(project.onDisk.pages.perPage.filter((one) => one.topIssues.length > 0).length);
  });

  it("H2 scores exactly as the disk evaluator did: the deductions, the clamp and the tolerant pending count", async () => {
    const health = await evaluateHealthFrom(sourcesOver([]));
    expect(health).toEqual(project.onDisk.health);
    expect([ruleOf(health, "broken-wikilink"), ruleOf(health, "pending-target"), ruleOf(health, "contradicted-page")]).toEqual([[[1, 4]], [[1, 0]], [[1, 2]]]);
    expect([ruleOf(health, "duplicate-concept"), ruleOf(health, "low-confidence")]).toEqual([[[2, 8]], [[1, 1]]]);
    expect(health.score).toBe(100 - health.rules.reduce((sum, one) => sum + one.deduction, 0));
    expect([health.maxScore, health.pendingReviews]).toEqual([100, 1]);
  });

  it("H3 counts 0 pending reviews when the count's own look fails, and still scores the lint run", async () => {
    const events: string[] = [];
    const candidates = candidatesOver(events, new Error("planted candidate look failure"));
    const health = await evaluateHealthFrom(sourcesOver(events, { candidates }));
    expect(health.pendingReviews).toBe(0);
    expect([health.score, health.rules]).toEqual([project.onDisk.health.score, project.onDisk.health.rules]);
    // The count looks first; the broken-wikilink rule looks later, after its page walk, and is answered.
    expect(events.indexOf(`candidates ${CANDIDATES_DIR}`)).toBeLessThan(events.indexOf(`page ${ALPHA}`));
  });

  it("H4 rejects with the lint run's own error", async () => {
    const failure = new Error("planted page read failure");
    const sources = sourcesOver([]);
    sources.pages.readText = async () => { throw failure; };
    await expect(evaluateHealthFrom(sources)).rejects.toBe(failure);
    await expect(evaluatePageHealthDistributionFrom(sources)).rejects.toBe(failure);
  });

  it("H5 reads each page once for the score's lint run, and once more for the distribution", async () => {
    const scored: string[] = [];
    await evaluateHealthFrom(sourcesOver(scored));
    expect(countOf(scored, `page ${ALPHA}`)).toBe(LINT_PAGE_READS);
    const distributed: string[] = [];
    await evaluatePageHealthDistributionFrom(sourcesOver(distributed));
    expect(countOf(distributed, `page ${ALPHA}`)).toBe(LINT_PAGE_READS + 1);
  });
});

describe("the per-page health distribution over the same copy", () => {
  it("D1 distributes exactly as the disk evaluator did, for the default, 2, 0 and -1 worst pages", async () => {
    expect(await evaluatePageHealthDistributionFrom(sourcesOver([]))).toEqual(project.onDisk.pages);
    expect(await evaluatePageHealthDistributionFrom(sourcesOver([]), 2)).toEqual(project.onDisk.worstTwo);
    expect(await evaluatePageHealthDistributionFrom(sourcesOver([]), 0)).toEqual(project.onDisk.worstNone);
    expect(await evaluatePageHealthDistributionFrom(sourcesOver([]), -1)).toEqual(project.onDisk.worstMinusOne);
  });

  it("D2 scores each page from its own findings, sorts worst first then by slug, and keeps the clean page", async () => {
    const result = await evaluatePageHealthDistributionFrom(sourcesOver([]));
    expect(entryOf(result, "concepts/alpha")).toEqual({ slug: "concepts/alpha", score: 96, tier: "healthy", topIssues: ["broken-wikilink", "pending-target"] });
    expect(entryOf(result, "concepts/fine")).toEqual({ slug: "concepts/fine", score: 100, tier: "healthy", topIssues: [] });
    expect(result.perPage.map((one) => one.slug)).toEqual(
      ["concepts/alpha", "concepts/twin-a", "concepts/twin-b", "concepts/disputed", "concepts/shaky", "concepts/fine"]);
    expect(result.perPage.map((one) => one.score)).toEqual([96, 96, 96, 98, 99, 100]);
    expect(result.distribution).toEqual({ healthy: 6, adequate: 0, needs_work: 0, broken: 0 });
  });

  it("D3 returns the worst pages by plain slicing: five by default, the first two, none, and all but the last", async () => {
    const all = (await evaluatePageHealthDistributionFrom(sourcesOver([]))).perPage;
    const worst = async (count?: number): Promise<unknown> => (await evaluatePageHealthDistributionFrom(sourcesOver([]), count)).worstPages;
    expect([await worst(), await worst(2), await worst(0), await worst(-1)]).toEqual([all.slice(0, 5), all.slice(0, 2), [], all.slice(0, -1)]);
  });

  it("D4 gives a finding that names no page an entry of its own", async () => {
    const journal: LintSources["journal"] = { openJournal: async () => ({ kind: "escape" }) };
    const result = await evaluatePageHealthDistributionFrom(sourcesOver([], { journal }));
    expect(entryOf(result, ".llmwiki/journal")).toEqual({ slug: ".llmwiki/journal", score: 99, tier: "healthy", topIssues: ["journal-health"] });
    expect(result.perPage).toHaveLength(project.onDisk.pages.perPage.length + 1);
  });
});
