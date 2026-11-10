/**
 * @file test/storage/eval-coverage-utilization-binding.test.ts
 * @description Citation coverage and source utilization as WHOLE consumers with
 * no project directory: `evaluateCitationCoverageFrom` and
 * `evaluateSourceUtilizationFrom`, with the source scan and the source resolver
 * they share. The two bodies exist only after the evaluators were given sources
 * of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two default-profile projects are minted on real disk. The
 * main one has three markdown sources, a text file, a nested directory, and
 * three links in `sources/` (to a sibling, to a file outside, to nothing), and
 * three pages whose citations reach each of those. The second has one link and
 * no regular source. The real root-taking evaluators and the real root-taking
 * scan answer. Each tree is copied as raw text and listings, each link's
 * resolved target is recorded as the disk gave it, and the directories are
 * removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The source selection and scan, the resolver's
 * lexical rules and both containment checks, the inventory and its warnings,
 * the page collection, the citation parser, and every count. The doubles answer
 * raw facts only: a listing, a text, what a location resolves to, what kind of
 * entry is at a location. No file list, resolved path, warning or count is
 * handed in.
 *
 * WHAT THE LOCATORS ARE. The resolver works on locators. Here they are strings
 * under the removed project's real path, kept only as names. That is the legacy
 * local identity, not a logical id; this file does not show a layout-free body.
 *
 * WHAT IS NOT SHOWN. A recursive or excluding source selection, a custom
 * profile, the evaluators' caller `runEval`, and anything a real disk decides
 * about links. The refused inventory file of U5 is PLANTED in a copy's listing
 * (its name holds `..` between backslashes, a file name on POSIX only); its
 * disk behaviour is pinned in `eval-reads.test.ts`.
 */

import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { evaluateCitationCoverage, evaluateCitationCoverageFrom, type CitationCoverageSources } from "../../src/eval/citation-coverage.js";
import { evaluateSourceUtilization, evaluateSourceUtilizationFrom, type SourceUtilizationSources } from "../../src/eval/source-utilization.js";
import type { CitationCoverageResult, SourceUtilizationResult } from "../../src/eval/types.js";
import { scanSelectedSources, scanSelectedSourcesFrom } from "../../src/sources/scan.js";
import type { LegacyLocalReads, LocalEntry } from "../../src/storage/legacy-local-reads.js";
import { CONCEPTS_DIR, QUERIES_DIR, SOURCES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, expectRemovedDefaultCopies, heldText, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Copy, type Minted } from "./copied-project.js";
import { lintSourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";

const PREFIX = "eval-coverage-utilization-";
const titled = (title: string, body: string): string => `---\ntitle: ${title}\n---\n\n${body}\n`;
/** Nine citations in five cited paragraphs of six. Six resolve: `missing.md`, the leaking link and the traversal do not. */
const FILES: Record<string, string> = {
  [`${SOURCES_DIR}/alpha.md`]: "# Alpha\n", [`${SOURCES_DIR}/beta.md`]: "# Beta\n", [`${SOURCES_DIR}/unused.md`]: "# Unused\n",
  [`${SOURCES_DIR}/notes.txt`]: "not markdown\n", [`${SOURCES_DIR}/deep/inner.md`]: "# Inner\n", "outside.md": "# Outside\n",
  [`${CONCEPTS_DIR}/one.md`]: titled("One", "One cites alpha precisely. ^[alpha.md:1-2]\n\nOne cites the alias and a nested file. ^[alias.md] ^[deep/inner.md]\n\nOne has an uncited paragraph."),
  [`${CONCEPTS_DIR}/two.md`]: titled("Two", "Two cites beta twice and a missing file. ^[beta.md] ^[beta.md:3] ^[missing.md]\n\nTwo cites a leaking link and a traversal. ^[leak.md] ^[../outside.md]"),
  [`${QUERIES_DIR}/one.md`]: titled("Query one", "The query cites alpha. ^[alpha.md]"),
};
/** Each link in `sources/`, and what it points at. */
const LINKS: Record<string, string> = { "alias.md": "alpha.md", "leak.md": "../outside.md", "dangling.md": "nowhere.md" };
const REFUSED = "odd\\..\\name.md";
const SYMLINK_WARNINGS = ["alias.md: symlink source excluded", "dangling.md: symlink source excluded", "leak.md: symlink source excluded"];

/** What the disk answered, and the two raw facts a copy cannot hold: the real root, and each link's resolved target (null when it resolves to nothing). */
interface OnDisk {
  real: string; resolved: Map<string, string | null>;
  coverage: CitationCoverageResult; utilization: SourceUtilizationResult; scan: Awaited<ReturnType<typeof scanSelectedSources>>;
}
type Project = Minted<OnDisk>;

async function seeded(root: string, files: Record<string, string>, links: Record<string, string>): Promise<void> {
  await writeFiles(root, files);
  // A project whose only sources are links has no file to bring `sources/` into being.
  await mkdir(path.join(root, SOURCES_DIR), { recursive: true });
  for (const [name, target] of Object.entries(links)) await symlink(target, path.join(root, SOURCES_DIR, name));
}

async function askedOnDisk(root: string, links: Record<string, string>): Promise<OnDisk> {
  const real = await realpath(root);
  const resolved = new Map<string, string | null>();
  for (const name of Object.keys(links)) {
    const rel = `${SOURCES_DIR}/${name}`;
    resolved.set(rel, await realpath(path.join(root, rel)).then((to) => path.relative(real, to), () => null));
  }
  return { real, resolved, coverage: await evaluateCitationCoverage(root), utilization: await evaluateSourceUtilization(root), scan: await scanSelectedSources(root) };
}

const tracker = tempRootTracker();
let main: Project;
let linkOnly: Project;

mintOnceThenRemove(tracker, async () => {
  main = await mintCopied(tracker, PREFIX, (root) => seeded(root, FILES, LINKS), (root) => askedOnDisk(root, LINKS));
  const only = { "alias.md": "../outside.md" };
  const files = { "outside.md": "# Outside\n", [`${CONCEPTS_DIR}/one.md`]: titled("One", "One cites a link that leaves. ^[alias.md]") };
  linkOnly = await mintCopied(tracker, PREFIX, (root) => seeded(root, files, only), (root) => askedOnDisk(root, only));
});

/** The location's path under the project, as the doubles key it. */
const relOf = (project: Project, location: string): string => location.slice(project.onDisk.real.length + 1);

/** The scan's reads over a copy: the configuration text (absent here, so the default selection) and the listings under one directory. */
function readsOver(copy: Copy, events: string[]): LegacyLocalReads {
  const listed = async (rel: string): Promise<LocalEntry[]> => {
    const entries = copy.listings.get(rel);
    if (entries === undefined) throw enoent();
    return entries;
  };
  return {
    readText: async (rel) => { events.push(`config ${rel}`); return heldText(copy, rel); },
    realDirectory: async (relDir) => {
      events.push(`directory ${relDir}`);
      if (!copy.listings.has(relDir)) return null;
      return { listEntries: (relative) => listed(relative === "" ? relDir : `${relDir}/${relative}`) };
    },
    exists: unasked("reads.exists"), statNoFollow: unasked("reads.statNoFollow"), listNames: unasked("reads.listNames"),
    readConfinedPage: unasked("reads.readConfinedPage"), readConfinedFile: unasked("reads.readConfinedFile"), locate: unasked("reads.locate"),
  };
}

/** The resolver's locations over a copy: a recorded link resolves where the disk said, a held file or directory resolves to itself, anything else does not resolve. */
function locationsOver(project: Project, events: string[]): CitationCoverageSources["locations"] {
  const { copy, onDisk: { real, resolved } } = project;
  return { sourcesDir: `${real}/${SOURCES_DIR}`, realPath: async (location) => {
    const rel = relOf(project, location);
    events.push(`real ${rel}`);
    const target = resolved.has(rel) ? resolved.get(rel) : copy.files.has(rel) || copy.listings.has(rel) ? rel : null;
    if (target === null || target === undefined) throw enoent();
    return `${real}/${target}`;
  } };
}

/** Coverage's sources over a copy. */
const coverageOver = (project: Project, events: string[]): CitationCoverageSources =>
  ({ pages: lintSourcesOver(project, events, NO_ENTITIES).pages, locations: locationsOver(project, events) });

/** Utilization's sources over a copy. The kind of an entry is what its directory's listing says; an entry no listing holds rejects. */
function utilizationOver(project: Project, events: string[]): SourceUtilizationSources {
  const kindNoFollow: SourceUtilizationSources["kindNoFollow"] = async (location) => {
    const rel = relOf(project, location);
    events.push(`kind ${rel}`);
    const entry = project.copy.listings.get(path.posix.dirname(rel))?.find((one) => one.name === path.posix.basename(rel));
    if (entry === undefined) throw enoent();
    return entry.kind;
  };
  return { ...coverageOver(project, events), reads: readsOver(project.copy, events), kindNoFollow };
}

/** `project` with one more regular file listed in `sources/`: a raw listing fact, planted. */
function withListed(project: Project, name: string): Project {
  const listings = new Map(project.copy.listings);
  listings.set(SOURCES_DIR, [...(listings.get(SOURCES_DIR) ?? []), { name, kind: "file" }]);
  return { ...project, copy: { files: project.copy.files, listings } };
}

/** A project that holds nothing at all. */
const nothing = (): Project => ({ ...main, copy: { files: new Map(), listings: new Map() } });

describe("citation coverage over a copied project, with the directory gone", () => {
  it("C1 runs after both minting directories were removed, on copies that recorded each link's target", () => {
    expectRemovedDefaultCopies([main, linkOnly], PREFIX);
    expect([...main.onDisk.resolved]).toEqual([[`${SOURCES_DIR}/alias.md`, `${SOURCES_DIR}/alpha.md`], [`${SOURCES_DIR}/leak.md`, "outside.md"], [`${SOURCES_DIR}/dangling.md`, null]]);
  });

  it("C2 measures exactly as the disk evaluator did: five of six paragraphs cited, six of nine citations valid", async () => {
    const coverage = await evaluateCitationCoverageFrom(coverageOver(main, []));
    expect(coverage).toEqual(main.onDisk.coverage);
    expect(coverage).toMatchObject({ totalProseParagraphs: 6, citedParagraphs: 5, coveragePercent: (5 / 6) * 100, totalCitations: 9, validCitations: 6, precisionPercent: (6 / 9) * 100 });
    const perPage = [...coverage.perPage].sort((left, right) => right.proseParagraphs - left.proseParagraphs);
    expect(perPage).toEqual([{ slug: "one", proseParagraphs: 3, citedParagraphs: 2 }, { slug: "two", proseParagraphs: 2, citedParagraphs: 2 }, { slug: "one", proseParagraphs: 1, citedParagraphs: 1 }]);
  });

  it("C3 resolves every span again, directory first: beta twice, and the traversal never reaches a lookup", async () => {
    const events: string[] = [];
    await evaluateCitationCoverageFrom(coverageOver(main, events));
    const lookups = events.filter((event) => event.startsWith("real "));
    expect(lookups.filter((event) => event === `real ${SOURCES_DIR}`)).toHaveLength(8);
    expect(lookups.filter((_, at) => at % 2 === 0).every((event) => event === `real ${SOURCES_DIR}`)).toBe(true);
    expect(lookups.filter((event) => event === `real ${SOURCES_DIR}/beta.md`)).toHaveLength(2);
    expect(lookups.filter((event) => event.includes("outside"))).toEqual([]);
  });

  it("C4 measures nothing as zeros, and rejects with a page read's own error", async () => {
    expect(await evaluateCitationCoverageFrom(coverageOver(nothing(), []))).toEqual(
      { totalProseParagraphs: 0, citedParagraphs: 0, coveragePercent: 0, totalCitations: 0, validCitations: 0, precisionPercent: 0, perPage: [] });
    const failure = new Error("planted page read failure");
    const sources = coverageOver(main, []);
    sources.pages.readText = async () => { throw failure; };
    await expect(evaluateCitationCoverageFrom(sources)).rejects.toBe(failure);
  });
});

describe("source utilization over the same copy", () => {
  it("U1 scans as the disk scan did: regular files and links apart, each sorted, the nested directory not entered", async () => {
    const scan = await scanSelectedSourcesFrom(readsOver(main.copy, []));
    expect(scan).toEqual(main.onDisk.scan);
    expect(scan).toEqual({ files: ["alpha.md", "beta.md", "notes.txt", "unused.md"], symlinks: ["alias.md", "dangling.md", "leak.md"] });
  });

  it("U2 measures exactly as the disk evaluator did: a citation of the alias counts for alpha, and the query page counts apart from the concept", async () => {
    const utilization = await evaluateSourceUtilizationFrom(utilizationOver(main, []));
    expect(utilization).toEqual(main.onDisk.utilization);
    expect(utilization).toEqual({
      totalSources: 3, citedSources: 2, uncitedSources: 1, utilizationRate: 0.667, warnings: SYMLINK_WARNINGS,
      perSource: [
        { sourceFile: "alpha.md", citingPageCount: 2, citingPages: ["concepts/one", "queries/one"] },
        { sourceFile: "beta.md", citingPageCount: 1, citingPages: ["concepts/two"] },
        { sourceFile: "unused.md", citingPageCount: 0, citingPages: [] },
      ],
    });
  });

  it("U3 resolves the whole inventory before it reads a page, then each page's cited files once", async () => {
    const events: string[] = [];
    await evaluateSourceUtilizationFrom(utilizationOver(main, events));
    const inventory = ["alpha.md", "beta.md", "unused.md"].flatMap((name) => [`real ${SOURCES_DIR}`, `real ${SOURCES_DIR}/${name}`]);
    expect(events.slice(0, 8)).toEqual([`config .llmwiki/config.json`, `directory ${SOURCES_DIR}`, ...inventory]);
    expect(events[8]).toMatch(/^page /);
    expect(events.filter((event) => event === `real ${SOURCES_DIR}`)).toHaveLength(10);
    expect(events.filter((event) => event.startsWith("kind "))).toEqual([]);
  });

  it("U4 returns early with the warning and reads no page when every source is a link, and measures nothing as not measured", async () => {
    const events: string[] = [];
    const utilization = await evaluateSourceUtilizationFrom(utilizationOver(linkOnly, events));
    expect(utilization).toEqual(linkOnly.onDisk.utilization);
    expect(utilization).toEqual({ totalSources: 0, citedSources: 0, uncitedSources: 0, utilizationRate: null, perSource: [], warnings: ["alias.md: symlink source excluded"] });
    expect(events).toEqual([`config .llmwiki/config.json`, `directory ${SOURCES_DIR}`]);
    expect((await evaluateSourceUtilizationFrom(utilizationOver(nothing(), []))).warnings).toEqual([]);
  });

  it("U5 warns about a listed file the resolver refuses, first, worded by one kind lookup: a file, a failed lookup, or a link", async () => {
    const planted = withListed(main, REFUSED);
    const events: string[] = [];
    const warningsWith = async (over: Partial<SourceUtilizationSources>): Promise<string[]> =>
      (await evaluateSourceUtilizationFrom({ ...utilizationOver(planted, events), ...over })).warnings;
    const generic = [`${REFUSED}: could not be resolved (excluded)`, ...SYMLINK_WARNINGS];
    expect(await warningsWith({})).toEqual(generic);
    expect(events.filter((event) => event.startsWith("kind "))).toEqual([`kind ${SOURCES_DIR}/${REFUSED}`]);
    expect(await warningsWith({ kindNoFollow: async () => { throw enoent(); } })).toEqual(generic);
    expect(await warningsWith({ kindNoFollow: async () => "link" })).toEqual([`${REFUSED}: symlink target missing or outside sources/ (excluded)`, ...SYMLINK_WARNINGS]);
  });

  it("U6 rejects with the error of a sources listing that fails", async () => {
    const failure = new Error("planted listing failure");
    const sources = utilizationOver(main, []);
    sources.reads.realDirectory = async () => ({ listEntries: async () => { throw failure; } });
    await expect(evaluateSourceUtilizationFrom(sources)).rejects.toBe(failure);
  });
});
