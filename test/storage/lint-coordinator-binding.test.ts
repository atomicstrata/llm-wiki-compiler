/**
 * @file test/storage/lint-coordinator-binding.test.ts
 * @description The lint coordinator as a WHOLE consumer with no project
 * directory: `lintBothViewsFrom` over `LintSources`. It exists only after the
 * coordinator was given sources of its own, so this file has NO before-edit
 * run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once each: one under
 * the default profile, with a broken link, a low-confidence page, a page whose
 * source changed since the compile state was written, and a page outside the
 * generic directories; and one under a legacy custom profile, with two entity
 * pages and one generic page. The real `lintBothViews(root)` answers for each
 * (and, for the default project, under the wiki-wide scope, and through `lint`
 * and `lintByTier`). Each tree is then copied as raw text and listings, and
 * the directories are removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The coordinator's one body; the schema loader;
 * the state classifier and the freshness snapshot with its hashing; every
 * registered rule's own body and page walk; the workflow status read with its
 * own profile load; the profile loader; the entity collection and every
 * profile check; the tier grouping. Inputs are raw text. No finding, snapshot,
 * schema or profile is handed to the body.
 *
 * WHAT IS NOT SHOWN. A schema file, a journal, embedding markers, workflow
 * runs, pending candidates, a product binding, relation or event stores with
 * content, and the tier refusal and confidence de-duplication that
 * `lint-tier-registry.test.ts` and `profile-lint-tiers.test.ts` pin on disk.
 * Whether rules overlap in time is not shown either: the log orders calls, it
 * does not time them. The doubles are those of `lint-sources-doubles.ts`: maps
 * of text and a call log. They are not a store, not an access-control layer and
 * not `ProjectStore`, and they show nothing about confinement on disk.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { lint, lintBothViews, lintBothViewsFrom, lintByTier } from "../../src/linter/index.js";
import type { LintSources } from "../../src/linter/lint-sources.js";
import type { TieredLintReportV1 } from "../../src/linter/tiers.js";
import type { LintResult, LintSummary } from "../../src/linter/types.js";
import { CONCEPTS_DIR, PROFILE_FILE, SOURCES_DIR, STATE_FILE } from "../../src/utils/constants.js";
import { serializeState } from "../../src/utils/state.js";
import { SAMPLE_PROFILE } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  countOf, expectRemovedDefaultCopies, expectRemovedLegacyProfileCopies, mintCopied, mintOnceThenRemove, writeFiles, type Minted,
} from "./copied-project.js";
import { entitiesOver, lintSourcesOver as sourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";

const PREFIX = "lint-coordinator-";
const ALPHA = `${CONCEPTS_DIR}/alpha.md`;
const EXTRA = "wiki/topics/extra.md";
const NOTE = "wiki/notes/short.md";
const CITED = "This body is long enough to count as a page and it cites its source. ^[a.md]";
const page = (title: string, front = "summary: A summary.", body = CITED): string => `---\ntitle: ${title}\n${front}\n---\n\n${body}\n`;
const LINKING = page("Alpha", undefined, "Alpha is long enough to count as a page and links to [[Missing Page]]. ^[a.md]");

/** The default-profile project: three generic pages, one page outside them, one source, and a state recording an older hash of it. */
const DEFAULT_FILES: Record<string, string> = {
  [ALPHA]: LINKING,
  [`${CONCEPTS_DIR}/shaky.md`]: page("Shaky", "summary: A summary.\nconfidence: 0.2"),
  [`${CONCEPTS_DIR}/tracked.md`]: page("Tracked"),
  [EXTRA]: page("Extra", undefined, "A page outside the generic directories, linking [[Missing Wide]]. ^[a.md]"),
  [`${SOURCES_DIR}/a.md`]: "A source.\n",
  [STATE_FILE]: serializeState({ version: 1, indexHash: "", sources: { "a.md": { hash: "old", concepts: ["tracked"], compiledAt: "t" } } }),
};
/** The custom-profile project: the sample profile, two `notes` pages and one generic page. */
const CUSTOM_FILES: Record<string, string> = {
  [PROFILE_FILE]: JSON.stringify(SAMPLE_PROFILE),
  [NOTE]: "---\ntitle: Short\n---\n\nTiny.\n",
  "wiki/notes/untitled.md": "---\nslug: untitled\n---\n\nUntitled note.\n",
  [ALPHA]: LINKING,
  [`${SOURCES_DIR}/a.md`]: "A source.\n",
};

type Views = { summary: LintSummary; tiered: TieredLintReportV1 };
/** What the disk coordinator answered for one project. */
interface OnDisk { real: string; both: Views; wide: Views; flat: LintSummary; tiered: TieredLintReportV1 }
const tracker = tempRootTracker();
let plain: Minted<OnDisk>;
let custom: Minted<OnDisk>;

/** Ask the real root-taking coordinator every way this suite compares. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  return {
    real: await realpath(root), both: await lintBothViews(root), wide: await lintBothViews(root, "wiki-wide"),
    flat: await lint(root), tiered: await lintByTier(root),
  };
}

mintOnceThenRemove(tracker, async () => {
  plain = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, DEFAULT_FILES), askedOnDisk);
  custom = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, CUSTOM_FILES), askedOnDisk);
});

const rulesOf = (results: readonly LintResult[]): string[] => results.map((result) => result.rule);
const firstOf = (log: string[], prefix: string): number => log.findIndex((call) => call.startsWith(prefix));
const lastOf = (log: string[], prefix: string): number => log.map((call) => call.startsWith(prefix)).lastIndexOf(true);
/** How many separate page walks one default run makes: ten plain page rules, the schema rule and the freshness rule. */
const PAGE_WALKS = 12;

describe("the lint coordinator over a copied default-profile project, with the directory gone", () => {
  it("C1 runs after both minting directories were removed", () => {
    expectRemovedDefaultCopies([plain], PREFIX);
    expectRemovedLegacyProfileCopies([custom], PREFIX);
  });

  it("C2 answers both views exactly as the disk coordinator did, and as `lint` and `lintByTier` did", async () => {
    const views = await lintBothViewsFrom(sourcesOver(plain, [], NO_ENTITIES));
    expect(views).toEqual(plain.onDisk.both);
    expect(views.summary).toEqual(plain.onDisk.flat);
    expect(views.tiered).toEqual(plain.onDisk.tiered);
    expect(rulesOf(views.summary.results)).toEqual(["broken-wikilink", "low-confidence", "stale-page"]);
    expect(views.summary.results.map((result) => path.relative(plain.dir, result.file)))
      .toEqual([ALPHA, `${CONCEPTS_DIR}/shaky.md`, `${CONCEPTS_DIR}/tracked.md`]);
    expect([rulesOf(views.tiered.deterministic), rulesOf(views.tiered.providerJudgement), rulesOf(views.tiered.derivedView)])
      .toEqual([["broken-wikilink"], ["low-confidence"], ["stale-page"]]);
  });

  it("C3 reads the schema first, then the state, then hashes the source, and only then starts the rules", async () => {
    const log: string[] = [];
    await lintBothViewsFrom(sourcesOver(plain, log, NO_ENTITIES));
    expect(log[0]?.startsWith("schema ")).toBe(true);
    expect(lastOf(log, "schema ")).toBeLessThan(log.indexOf(`state ${STATE_FILE}`));
    expect(log.indexOf(`state ${STATE_FILE}`)).toBeLessThan(log.indexOf("freshness open"));
    expect(countOf(log, "freshness open")).toBe(1);
    expect(countOf(log, `freshness read ${SOURCES_DIR}/a.md`)).toBe(1);
    expect(log.indexOf(`freshness read ${SOURCES_DIR}/a.md`)).toBeLessThan(firstOf(log, "page "));
    expect(firstOf(log, "freshness read")).toBeLessThan(firstOf(log, "workflow."));
  });

  it("C4 walks the pages once per page rule, and loads the appendix profile last and apart from the workflow rule's", async () => {
    const log: string[] = [];
    await lintBothViewsFrom(sourcesOver(plain, log, NO_ENTITIES));
    expect(countOf(log, `page ${ALPHA}`)).toBe(PAGE_WALKS);
    expect(countOf(log, `page ${EXTRA}`)).toBe(0);
    expect(countOf(log, "workflow.leaf profile.json")).toBe(1);
    expect(countOf(log, "appendix.leaf profile.json")).toBe(1);
    // Every appendix call comes after every other call of the run: nothing was loaded early or shared.
    expect(log.slice(firstOf(log, "appendix.")).filter((call) => !call.startsWith("appendix."))).toEqual([]);
    expect(firstOf(log, "appendix.")).toBeGreaterThan(lastOf(log, "page "));
  });

  it("C5 passes the wiki-wide scope to the broken-wikilink rule only", async () => {
    const log: string[] = [];
    const views = await lintBothViewsFrom(sourcesOver(plain, log, NO_ENTITIES), "wiki-wide");
    expect(views).toEqual(plain.onDisk.wide);
    expect(countOf(log, `page ${EXTRA}`)).toBe(1);
    expect(countOf(log, `page ${ALPHA}`)).toBe(PAGE_WALKS);
    const broken = views.summary.results.filter((result) => result.rule === "broken-wikilink");
    expect(broken.map((result) => path.relative(plain.dir, result.file)).sort()).toEqual([ALPHA, EXTRA]);
    expect(rulesOf(views.summary.results).filter((rule) => rule !== "broken-wikilink")).toEqual(["low-confidence", "stale-page"]);
  });

  it("C6 rejects with the schema read's own error before the state or any rule is asked", async () => {
    const failure = new Error("planted schema read failure");
    const log: string[] = [];
    const schema = { exists: async () => true, readText: async () => { throw failure; } } as unknown as LintSources["schema"];
    await expect(lintBothViewsFrom(sourcesOver(plain, log, NO_ENTITIES, { schema }))).rejects.toBe(failure);
    expect(log).toEqual([]);
  });

  it("C7 rejects with a page read's own error and never loads the appendix profile", async () => {
    const failure = new Error("planted page read failure");
    const log: string[] = [];
    const sources = sourcesOver(plain, log, NO_ENTITIES);
    sources.pages.readText = async () => { throw failure; };
    await expect(lintBothViewsFrom(sources)).rejects.toBe(failure);
    expect(firstOf(log, "appendix.")).toBe(-1);
    expect(countOf(log, "freshness open")).toBe(1);
  });
});

describe("the lint coordinator over a copied legacy-profile project", () => {
  it("C8 answers both views exactly as the disk coordinator did, with the profile findings after the default ones", async () => {
    const log: string[] = [];
    const views = await lintBothViewsFrom(sourcesOver(custom, log, entitiesOver(custom, (call) => { log.push(call); })));
    expect(views).toEqual(custom.onDisk.both);
    const tagged = views.summary.results.map((result) => result.entityType !== undefined);
    expect(tagged.includes(true)).toBe(true);
    expect(tagged.lastIndexOf(false)).toBeLessThan(tagged.indexOf(true));
    expect(views.summary.results.filter((result) => result.entityType !== undefined && result.entityType !== "notes")).toEqual([]);
  });

  it("C9 collects the entities once, after the appendix profile load, which follows every default rule's page reads", async () => {
    const log: string[] = [];
    await lintBothViewsFrom(sourcesOver(custom, log, entitiesOver(custom, (call) => { log.push(call); })));
    expect(countOf(log, `read ${NOTE}`)).toBe(1);
    expect(countOf(log, "appendix.leaf profile.json")).toBe(1);
    expect(countOf(log, "workflow.leaf profile.json")).toBe(1);
    expect(log.indexOf("appendix.leaf profile.json")).toBeGreaterThan(lastOf(log, "page "));
    expect(log.indexOf(`read ${NOTE}`)).toBeGreaterThan(log.indexOf("appendix.leaf profile.json"));
    expect(firstOf(log, "graph ")).toBeGreaterThan(log.indexOf(`read ${NOTE}`));
  });

  it("C10 rejects with the entity scan's own error after the default rules ran", async () => {
    const failure = new Error("planted scan failure");
    const log: string[] = [];
    const entities = { ...entitiesOver(custom, () => {}), scans: { openEntityDirectory: async () => { throw failure; } } };
    await expect(lintBothViewsFrom(sourcesOver(custom, log, entities))).rejects.toBe(failure);
    expect(countOf(log, `page ${ALPHA}`)).toBe(PAGE_WALKS);
    expect(countOf(log, "appendix.leaf profile.json")).toBe(1);
  });
});
