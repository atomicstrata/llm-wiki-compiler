/**
 * @file test/storage/lint-rules-binding.test.ts
 * @description The default lint rules that walk pages, the schema cross-link
 * walker and the fix planner, each as a WHOLE consumer with no project
 * directory: `check...From` and `planLintFixesFrom`. They exist only after the
 * rules were given sources of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once: a wiki in which
 * each rule has exactly the pages that trip it, one page outside the generic
 * directories, and two pending candidates persisted by the real
 * `writeCandidate`, one default and one typed. Every root-taking consumer is
 * asked on that disk, the tree is copied into memory, and the directory is
 * removed before any case runs. See `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Each consumer's one body, the real page
 * collection beneath it in the scope the consumer asks for, and, for the
 * broken-wikilink rule and the fix planner, the real tolerant candidate list
 * and its typed-candidate rule over the RAW candidate records. The inputs are
 * raw page texts, raw listings and raw candidate records. No finding, slug set
 * or plan is copied in. The freshness snapshot and the schema are VALUES the
 * caller passes to a rule on disk too; the same two values are passed here.
 *
 * WHAT IS COMPARED. Each consumer's answer in memory against the answer its
 * root-taking form gave on disk, deeply: rule, severity, reported file, line,
 * message and order. Each is also held to a written-out list of what it flags.
 *
 * WHAT IT DOES NOT SHOW. Nothing the local disk decides, and nothing about the
 * citation rules, the lint orchestrator, the lint cache, any writer or the
 * commands: those still take a root. The doubles are not a hosted store, not
 * an access-control layer and not `ProjectStore`.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import { writeCandidate } from "../../src/compiler/candidates.js";
import type { FreshnessSnapshot } from "../../src/freshness/types.js";
import { planLintFixes, planLintFixesFrom, type LintFixPlanV1 } from "../../src/linter/fix-plan.js";
import { checkSchemaCrossLinks, checkSchemaCrossLinksFrom } from "../../src/linter/rules-crosslinks.js";
import type { LintLinkSources } from "../../src/linter/rules-shared.js";
import * as rules from "../../src/linter/rules.js";
import type { LintResult } from "../../src/linter/types.js";
import { buildDefaultSchema } from "../../src/schema/index.js";
import type { LocalEntry } from "../../src/storage/legacy-local-reads.js";
import { CANDIDATES_DIR, CONCEPTS_DIR, QUERIES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, heldText, mintCopied, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "lint-rules-";
const ALPHA = `${CONCEPTS_DIR}/alpha.md`;
const EXTRA = "wiki/topics/extra.md";
const CITED = "This body is long enough to count as a page and it cites its source. ^[source.md]";
const LINKS = "Links to [[beta]], [[Missing Page]], [[Queued Thing]], [[Typed Thing]], [[Real Title]] and [[Twin Title]]. ^[source.md]";
/** A page with a title, a summary unless `front` says otherwise, and a body. */
const page = (title: string, front = "summary: A summary.", body = CITED): string => `---\ntitle: ${title}\n${front}\n---\n\n${body}\n`;

/** The pages, by what each is there to trip. Every other rule must leave it alone. */
const PAGES: Record<string, string> = {
  [ALPHA]: page("Alpha", undefined, LINKS),
  [`${CONCEPTS_DIR}/beta.md`]: page("Beta", "summary: A summary.\norphaned: true"),
  [`${CONCEPTS_DIR}/real-slug.md`]: page("Real Title"),
  [`${CONCEPTS_DIR}/twin-a.md`]: page("Twin Title"),
  [`${CONCEPTS_DIR}/twin-b.md`]: page("Twin Title"),
  [`${CONCEPTS_DIR}/nosummary.md`]: page("No Summary", "kind: concept"),
  [`${CONCEPTS_DIR}/short.md`]: page("Short", undefined, "Tiny."),
  [`${CONCEPTS_DIR}/shaky.md`]: page("Shaky", "summary: A summary.\nconfidence: 0.2"),
  [`${CONCEPTS_DIR}/disputed.md`]: page("Disputed", "summary: A summary.\ncontradictedBy: [beta, alpha]"),
  [`${CONCEPTS_DIR}/prose.md`]: page("Prose", undefined, "One uncited paragraph of prose.\n\nTwo uncited paragraphs of prose.\n\nThree uncited paragraphs of prose."),
  [`${CONCEPTS_DIR}/tracked.md`]: page("Tracked"),
  [`${CONCEPTS_DIR}/lost.md`]: page("Lost"),
  [`${CONCEPTS_DIR}/hub.md`]: page("Hub", "summary: A summary.\nkind: overview", "The hub gathers the wiki and points at [[beta]] for the rest. ^[source.md]"),
  [`${QUERIES_DIR}/tracked.md`]: page("Saved Tracked"),
  [EXTRA]: page("Extra", undefined, "A page outside the generic directories, linking [[Missing Wide]]. ^[source.md]"),
};
/** `tracked` has a changed source and `lost` a deleted one; the query page of the same slug is never either. */
const SNAPSHOT: FreshnessSnapshot = { stateStatus: "ok", sources: {
  "a.md": { recordedHash: "old", currentHash: "new", exists: true, concepts: ["tracked"] },
  "gone.md": { recordedHash: "was", currentHash: null, exists: false, concepts: ["lost"] },
} };
const SCHEMA = buildDefaultSchema();

/** One consumer: its name, its root-taking form, its body over sources, and what it must flag as sorted `<rule or kind>:<file>`. */
type Consumer = [name: string, onDisk: (root: string) => Promise<unknown>, inMemory: (sources: LintLinkSources) => Promise<unknown>, flags: string[]];
const at = (rule: string, file: string, times = 1): string[] => Array<string>(times).fill(`${rule}:${file}`);
const CONSUMERS: Consumer[] = [
  ["broken wikilinks, generic", (root) => rules.checkBrokenWikilinks(root), (sources) => rules.checkBrokenWikilinksFrom(sources), [...at("broken-wikilink", ALPHA, 4), ...at("pending-target", ALPHA)]],
  ["broken wikilinks, wiki-wide", (root) => rules.checkBrokenWikilinks(root, "wiki-wide"), (sources) => rules.checkBrokenWikilinksFrom(sources, "wiki-wide"),
    [...at("broken-wikilink", ALPHA, 4), ...at("broken-wikilink", EXTRA), ...at("pending-target", ALPHA)]],
  ["orphaned pages", rules.checkOrphanedPages, ({ pages }) => rules.checkOrphanedPagesFrom(pages), at("orphaned-page", `${CONCEPTS_DIR}/beta.md`)],
  ["stale pages", (root) => rules.checkStalePages(root, SNAPSHOT), ({ pages }) => rules.checkStalePagesFrom(pages, SNAPSHOT),
    [...at("orphaned-page", `${CONCEPTS_DIR}/lost.md`), ...at("stale-page", `${CONCEPTS_DIR}/tracked.md`)]],
  ["missing summaries", rules.checkMissingSummaries, ({ pages }) => rules.checkMissingSummariesFrom(pages), at("missing-summary", `${CONCEPTS_DIR}/nosummary.md`)],
  ["duplicate concepts", rules.checkDuplicateConcepts, ({ pages }) => rules.checkDuplicateConceptsFrom(pages),
    [...at("duplicate-concept", `${CONCEPTS_DIR}/twin-a.md`), ...at("duplicate-concept", `${CONCEPTS_DIR}/twin-b.md`)]],
  ["empty pages", rules.checkEmptyPages, ({ pages }) => rules.checkEmptyPagesFrom(pages), at("empty-page", `${CONCEPTS_DIR}/short.md`)],
  ["low confidence", rules.checkLowConfidencePages, ({ pages }) => rules.checkLowConfidencePagesFrom(pages), at("low-confidence", `${CONCEPTS_DIR}/shaky.md`)],
  ["contradicted pages", rules.checkContradictedPages, ({ pages }) => rules.checkContradictedPagesFrom(pages), at("contradicted-page", `${CONCEPTS_DIR}/disputed.md`)],
  ["inferred without citations", rules.checkInferredWithoutCitations, ({ pages }) => rules.checkInferredWithoutCitationsFrom(pages), at("excess-inferred-paragraphs", `${CONCEPTS_DIR}/prose.md`)],
  ["schema cross-links", (root) => checkSchemaCrossLinks(root, SCHEMA), ({ pages }) => checkSchemaCrossLinksFrom(pages, SCHEMA), at("schema-cross-link-minimum", `${CONCEPTS_DIR}/hub.md`)],
  ["fix plan, wiki-wide by default", (root) => planLintFixes(root), (sources) => planLintFixesFrom(sources), [...at("fix", ALPHA), ...at("recommendation", ALPHA, 3), ...at("recommendation", EXTRA)]],
  ["fix plan, generic", (root) => planLintFixes(root, "generic"), (sources) => planLintFixesFrom(sources, "generic"), [...at("fix", ALPHA), ...at("recommendation", ALPHA, 3)]],
];

const tracker = tempRootTracker();
let wiki: Minted<unknown[]>;

/** The pages, then a default pending candidate and a typed one. */
async function seed(root: string): Promise<void> {
  await writeFiles(root, PAGES);
  const pending = { title: "Pending", summary: "Pending", sources: [], body: "Pending body." };
  await writeCandidate(root, { ...pending, slug: "queued-thing" });
  await writeCandidate(root, { ...pending, slug: "typed-thing", targetEntityType: "papers" });
}

/** Every consumer's root-taking form asked on the real disk, in table order. */
async function askedOnDisk(root: string): Promise<unknown[]> {
  const answers: unknown[] = [];
  for (const [, onDisk] of CONSUMERS) answers.push(await onDisk(root));
  return answers;
}

mintOnceThenRemove(tracker, async () => { wiki = await mintCopied(tracker, PREFIX, seed, askedOnDisk); });

/** What `failing` makes a source reject with: every page read, or the candidate directory. */
interface Failing { read?: Error; candidates?: Error }

/**
 * The link sources over the copy. A reported path is where the page WAS on
 * disk. Each page read and the candidate directory's opening are logged; with
 * `failing`, that call rejects with the given error instead of answering.
 */
function sourcesOver(log: string[] = [], failing: Failing = {}): LintLinkSources {
  const { copy, dir } = wiki;
  const listed = (relDir: string): LocalEntry[] => copy.listings.get(relDir) ?? (() => { throw enoent(); })();
  return {
    pages: {
      exists: async (rel) => copy.listings.has(rel),
      listNames: async (relDir) => listed(relDir).map(({ name }) => name),
      listEntries: async (relDir) => listed(relDir),
      readText: async (rel) => { log.push(`read ${rel}`); if (failing.read) throw failing.read; return heldText(copy, rel); },
      locate: (rel) => path.join(dir, rel),
    },
    candidates: {
      directory: async (relDir) => {
        log.push(`candidates ${relDir}`);
        if (failing.candidates) throw failing.candidates;
        return copy.listings.has(relDir) ? { exists: async () => true, listEntries: async () => listed(relDir) } : null;
      },
      leaf: async (relDir, fileName) => ({ location: `memory:${fileName}`, readText: async () => heldText(copy, `${relDir}/${fileName}`) }),
    },
  };
}

/** What an answer flags, as sorted `<rule>:<file>` for findings and `<kind>:<file>` for plans, files project-relative. */
function flagged(answer: unknown): string[] {
  const relative = (file: string): string => path.relative(wiki.dir, file);
  return (answer as Array<LintResult | LintFixPlanV1>).map((one) => {
    if (!("kind" in one)) return `${one.rule}:${relative(one.file)}`;
    return `${one.kind}:${relative(one.kind === "fix" ? one.edit.file : one.file)}`;
  }).sort();
}

describe("lint rules, schema cross-links and the fix plan over a copied project, with the directory gone", () => {
  it("R1 runs after the minting directory was removed, on a copy holding the pages as seeded and the raw candidate records", () => {
    expectMintingDirectoryRemoved(wiki.dir, PREFIX);
    expect(Object.keys(PAGES).filter((rel) => wiki.copy.files.get(rel) !== PAGES[rel])).toEqual([]);
    const records = wiki.copy.listings.get(CANDIDATES_DIR)!.filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"))
      .map((entry) => JSON.parse(heldText(wiki.copy, `${CANDIDATES_DIR}/${entry.name}`)) as Record<string, unknown>);
    expect(records.map((record) => `${String(record.slug)}:${String(record.targetEntityType)}`).sort()).toEqual(["queued-thing:undefined", "typed-thing:papers"]);
  });

  it.each(CONSUMERS.map(([name, , inMemory, flags], index) => ({ name, inMemory, flags, index })))(
    "R2 $name: the body answers exactly what the root-taking form answered on disk, and flags exactly what it should",
    async ({ inMemory, flags, index }) => {
      const answer = await inMemory(sourcesOver());
      expect(answer).toEqual(wiki.onDisk[index]);
      expect(flagged(answer)).toEqual([...flags].sort());
    },
  );

  it("R3 the broken-wikilink rule reports a default pending target as pending, a typed pending target as broken, and each in link order with its line", async () => {
    const file = path.join(wiki.dir, ALPHA);
    const broken = (target: string): LintResult => ({ rule: "broken-wikilink", severity: "error", file, message: `Broken wikilink [[${target}]] — no matching page found`, line: 6 });
    expect(await rules.checkBrokenWikilinksFrom(sourcesOver())).toEqual([
      broken("Missing Page"),
      { rule: "pending-target", severity: "info", file, message: "Wikilink [[Queued Thing]] points to a page awaiting review", line: 6 },
      broken("Typed Thing"), broken("Real Title"), broken("Twin Title"),
    ]);
  });

  it("R4 the fix plan retargets the one link a single title names, refuses the ambiguous and the unknown, plans nothing for the pending link, and sees the wider page by default", async () => {
    const advice = (target: string, why: string, rel = ALPHA): LintFixPlanV1 => ({
      kind: "recommendation", rule: "broken-wikilink", file: path.join(wiki.dir, rel), advice: `[[${target}]] cannot be repaired automatically: ${why}`,
    });
    expect(await planLintFixesFrom(sourcesOver())).toEqual([
      advice("Missing Page", "no page carries that title"), advice("Typed Thing", "no page carries that title"),
      { kind: "fix", rule: "broken-wikilink", edit: { file: path.join(wiki.dir, ALPHA), line: 6, from: "[[Real Title]]", to: "[[real-slug|Real Title]]" } },
      advice("Twin Title", "2 pages carry that title, so the target is ambiguous"),
      advice("Missing Wide", "no page carries that title", EXTRA),
    ]);
  });

  it("R5 the planner and the rule disagree about no link: in the same scope, one plan per broken finding and none for the pending one", async () => {
    const findings = await rules.checkBrokenWikilinksFrom(sourcesOver(), "wiki-wide");
    const plans = await planLintFixesFrom(sourcesOver(), "wiki-wide");
    const brokenFiles = findings.filter((finding) => finding.rule === "broken-wikilink").map((finding) => finding.file);
    expect(plans.map((plan) => (plan.kind === "fix" ? plan.edit.file : plan.file))).toEqual(brokenFiles);
    expect([brokenFiles.length, findings.length]).toEqual([5, 6]);
  });
});

describe("what the lint consumers read, and what a failing source does to them", () => {
  it("R6 each rule collects the pages itself, and the candidate records are opened once, after every page read", async () => {
    const log: string[] = [];
    await rules.checkOrphanedPagesFrom(sourcesOver(log).pages);
    const once = log.length;
    await rules.checkEmptyPagesFrom(sourcesOver(log).pages);
    expect([once, log.length, log.filter((call) => call.startsWith("candidates "))]).toEqual([14, 28, []]);
    const linked: string[] = [];
    await rules.checkBrokenWikilinksFrom(sourcesOver(linked));
    expect([linked.length, linked.findIndex((call) => call.startsWith("candidates "))]).toEqual([15, 14]);
  });

  it("R7 a page read's own error rejects every consumer family, and a candidate directory's own error rejects the rule and the planner", async () => {
    const [read, candidates] = [new Error("planted page read failure"), new Error("planted candidate failure")];
    await expect(rules.checkMissingSummariesFrom(sourcesOver([], { read }).pages)).rejects.toBe(read);
    await expect(checkSchemaCrossLinksFrom(sourcesOver([], { read }).pages, SCHEMA)).rejects.toBe(read);
    await expect(planLintFixesFrom(sourcesOver([], { read }))).rejects.toBe(read);
    await expect(rules.checkBrokenWikilinksFrom(sourcesOver([], { candidates }))).rejects.toBe(candidates);
    await expect(planLintFixesFrom(sourcesOver([], { candidates }))).rejects.toBe(candidates);
  });
});
