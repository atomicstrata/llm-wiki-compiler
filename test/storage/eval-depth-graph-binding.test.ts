/**
 * @file test/storage/eval-depth-graph-binding.test.ts
 * @description Citation depth and graph health as WHOLE consumers with no
 * project directory: `evaluateCitationDepthFrom` over `LintPageSources`, and
 * `evaluateGraphHealthFrom` over `LegacyLocalEntityScans`. They exist only
 * after the two evaluators were given sources of their own, so this file has
 * NO before-edit run.
 *
 * ONE FILE FOR BOTH. The two evaluators read the same five pages through two
 * different existing seams, so one minted project and one copy serve both.
 *
 * HOW IT IS BUILT. One default-profile project is minted on real disk: four
 * concept pages and one query page, with two real two-way links, one-way links,
 * two targets that do not exist, an isolated page, and citations that are
 * precise, vague, and one inside a list item. The real root-taking evaluators
 * answer. The tree is copied as raw text and listings and the directory is
 * removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. For citation depth: the real page collection,
 * the frontmatter parse, the prose-paragraph split and the citation parser. For
 * graph health: the real raw page scan, the viewer's decoration and link
 * resolution, the viewer's graph builder, and every metric. Inputs are raw
 * text. No page list, graph or count is handed in.
 *
 * WHAT IS NOT SHOWN. More than five hub pages or five dangling targets (the
 * caps), aliases, a custom profile's typed pages, and the evaluators' caller
 * `runEval`. The doubles are the shared lint page double and the shared entity
 * scans double: maps of text and a call log. They show nothing about links or
 * confinement on disk.
 */

import { realpath } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { evaluateCitationDepth, evaluateCitationDepthFrom } from "../../src/eval/citation-depth.js";
import { evaluateGraphHealth, evaluateGraphHealthFrom } from "../../src/eval/graph-health.js";
import type { CitationDepthResult, GraphHealthResult } from "../../src/eval/types.js";
import type { LegacyLocalEntityScans } from "../../src/storage/legacy-local-reads.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { countOf, entityScansOf, expectRemovedDefaultCopies, mintCopied, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { lintSourcesOver, NO_ENTITIES, type CopiedLintProject } from "./lint-sources-doubles.js";

const PREFIX = "eval-depth-graph-";
const BETA = `${CONCEPTS_DIR}/b.md`;
const titled = (title: string, body: string): string => `---\ntitle: ${title}\n---\n\n${body}\n`;
/**
 * Five pages. Citations: `a` carries one precise, then one vague and one
 * precise; `b` one vague; `c` one inside a list item, which is not prose.
 * Links: a↔b, b→c, q→a; `a` and `b` both name Ghost One and `b` names Ghost
 * Two, neither of which exists; `island` links nothing and is linked by none.
 */
const FILES: Record<string, string> = {
  [`${CONCEPTS_DIR}/a.md`]: titled("A", "Alpha opens with a precise claim. ^[s.md:1-3]\n\nAlpha links [[b]] and [[Ghost One]] with two more claims. ^[s.md] ^[t.md:5-6]"),
  [BETA]: titled("B", "Beta links [[a]], [[c]], [[Ghost One]] and [[Ghost Two]]. ^[s.md]"),
  [`${CONCEPTS_DIR}/c.md`]: titled("C", "Gamma has prose and no links.\n\n- a list item that is not prose ^[s.md:9]"),
  [`${CONCEPTS_DIR}/island.md`]: titled("Island", "# A heading is not prose\n\nIsland stands alone."),
  [`${QUERIES_DIR}/q.md`]: titled("Q", "Query asks about [[a]]."),
};

/** What the disk evaluators answered. */
interface OnDisk { real: string; depth: CitationDepthResult; graph: GraphHealthResult | null }
const tracker = tempRootTracker();
let project: Minted<OnDisk>;

mintOnceThenRemove(tracker, async () => {
  project = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, FILES), async (root) => ({
    real: await realpath(root), depth: await evaluateCitationDepth(root), graph: await evaluateGraphHealth(root),
  }));
});

/** A project that holds nothing: no page directory at all. */
const NOTHING: CopiedLintProject = { dir: "memory:empty", onDisk: { real: "memory:empty" }, copy: { files: new Map(), listings: new Map() } };

/** The page collection's sources over a copy, from the shared lint doubles. Each page read is logged as `page <path>`. */
const pagesOver = (from: CopiedLintProject, events: string[]) => lintSourcesOver(from, events, NO_ENTITIES).pages;
/** The viewer collector's scans over a copy, from the shared entity scans double. Each read is logged as `read <path>`. */
const scansOver = (from: CopiedLintProject, events: string[]): LegacyLocalEntityScans =>
  entityScansOf(from.copy, from.onDisk.real, (call) => { events.push(call); });

/** `scans`, except that reading `rel` rejects: what one unreadable page looks like to the collector. */
function withUnreadable(scans: LegacyLocalEntityScans, rel: string): LegacyLocalEntityScans {
  return { openEntityDirectory: async (relDir) => {
    const opened = await scans.openEntityDirectory(relDir);
    if (opened.status !== "ok") return opened;
    const { directory } = opened;
    const readText = async (entry: string): Promise<string> => {
      if (entry.endsWith(rel)) throw new Error("planted page read failure");
      return directory.readText(entry);
    };
    return { status: "ok", directory: { ...directory, readText } };
  } };
}

describe("citation depth over a copied project, with the directory gone", () => {
  it("G1 runs after the minting directory was removed", () => {
    expectRemovedDefaultCopies([project], PREFIX);
    expect(project.onDisk.graph).not.toBeNull();
  });

  it("G2 measures exactly as the disk evaluator did: four citations, two of them precise, over six prose paragraphs", async () => {
    const events: string[] = [];
    const depth = await evaluateCitationDepthFrom(pagesOver(project, events));
    expect(depth).toEqual(project.onDisk.depth);
    expect(depth).toEqual({ totalCitations: 4, preciseCitations: 2, vagueCitations: 2, claimLevelRate: 0.5, avgCitationsPerParagraph: 4 / 6 });
    expect([countOf(events, `page ${BETA}`), countOf(events, `page ${QUERIES_DIR}/q.md`)]).toEqual([1, 1]);
  });

  it("G3 measures nothing as zeros, and rejects with a page read's own error", async () => {
    expect(await evaluateCitationDepthFrom(pagesOver(NOTHING, []))).toEqual(
      { totalCitations: 0, preciseCitations: 0, vagueCitations: 0, claimLevelRate: 0, avgCitationsPerParagraph: 0 });
    const failure = new Error("planted page read failure");
    const pages = pagesOver(project, []);
    pages.readText = async () => { throw failure; };
    await expect(evaluateCitationDepthFrom(pages)).rejects.toBe(failure);
  });
});

describe("graph health over the same copy", () => {
  it("G4 measures exactly as the disk evaluator did, reading each page once", async () => {
    const events: string[] = [];
    const graph = await evaluateGraphHealthFrom(scansOver(project, events));
    expect(graph).toEqual(project.onDisk.graph);
    expect(events.filter((event) => event.startsWith("open "))).toEqual([`open ${CONCEPTS_DIR}`, `open ${QUERIES_DIR}`]);
    expect([countOf(events, `read ${BETA}`), events.filter((event) => event.startsWith("read ")).length]).toEqual([1, 5]);
  });

  it("G5 counts real pages, links between them, components and the two missing targets", async () => {
    const graph = await evaluateGraphHealthFrom(scansOver(project, []));
    expect(graph).toMatchObject({ pageCount: 5, unreferencedCount: 2, componentCount: 2, avgIndegree: 0.8, danglingCount: 2 });
    expect([...(graph?.unreferencedPages ?? [])].sort()).toEqual(["concepts/island", "queries/q"]);
    expect(graph?.hubPages).toEqual([
      { id: "concepts/a", indegree: 2, outdegree: 1, totalDegree: 3 },
      { id: "concepts/b", indegree: 1, outdegree: 2, totalDegree: 3 },
      { id: "concepts/c", indegree: 1, outdegree: 0, totalDegree: 1 },
      { id: "queries/q", indegree: 0, outdegree: 1, totalDegree: 1 },
    ]);
    expect(graph?.topDangling).toEqual([
      { id: "concepts/ghost-one", title: "Ghost One", referenceCount: 2 },
      { id: "concepts/ghost-two", title: "Ghost Two", referenceCount: 1 },
    ]);
  });

  it("G6 answers null when there is no page at all", async () => {
    expect(await evaluateGraphHealthFrom(scansOver(NOTHING, []))).toBeNull();
  });

  it("G7 leaves out a page that cannot be read, so its links become missing targets", async () => {
    const graph = await evaluateGraphHealthFrom(withUnreadable(scansOver(project, []), "/b.md"));
    expect(graph).toMatchObject({ pageCount: 4, danglingCount: 2, componentCount: 3 });
    expect(graph?.topDangling.map((one) => one.id)).toEqual(["concepts/b", "concepts/ghost-one"]);
  });

  it("G8 passes on the same error when the scans' own directory open rejects", async () => {
    const failure = new Error("planted directory open failure");
    const scans: LegacyLocalEntityScans = { openEntityDirectory: async () => { throw failure; } };
    await expect(evaluateGraphHealthFrom(scans)).rejects.toBe(failure);
  });
});
