/**
 * @file test/storage/viewer-snapshot-legacy.test.ts
 * @description The viewer snapshot through its ROOT function,
 * `buildViewerSnapshot`, on real files with nothing mocked. It pins one small
 * project's WHOLE snapshot as a literal value, and three degraded projects, so
 * that building the snapshot over storage bindings cannot move any of it. It is
 * run byte for byte against the source both before and after.
 *
 * What is literal and what is computed, stated once: `generatedAt` is asserted
 * to be an ISO instant and then removed, because it is the clock. `root`, the
 * project header and each page's `filePath` are computed from the fixture root
 * and from nothing else. Everything else is written out, page bodies included:
 * no body is trimmed or normalised. There is ONE page in each directory, with
 * distinct timestamps, so no expectation depends on the host's listing order.
 *
 * L5 pins the four root-named readers the snapshot is built from, each with a
 * literal answer on the same project.
 */

import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { countCandidates } from "../../src/compiler/candidate-read.js";
import { listSelectedSourceEntries } from "../../src/sources/scan.js";
import { collectViewerPages } from "../../src/viewer/collect.js";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { collectRawWikiPages } from "../../src/wiki/collect.js";

let root = "";
const at = (relative: string): string => path.join(root, relative);
const ALPHA_BODY = "\nAlpha links to [[question]] and [[Missing Page]]. ^[notes.md]\n";
const QUESTION_BODY = "\nAsks about [[alpha]]. ^[gone.md:3]\n";
const INDEX_BODY = "# Index\n\n[[alpha]] and [[question]].\n";
const FRESHNESS = { contradicted: false, archived: false };

/** Write a file under the fixture root, creating its directory. */
async function put(relative: string, text: string): Promise<void> {
  await mkdir(path.dirname(at(relative)), { recursive: true });
  await writeFile(at(relative), text);
}

/** One concept, one query, an index, one source, a compile state that owns the concept, one pending candidate. */
async function seed(): Promise<void> {
  await put("wiki/concepts/alpha.md", `---\ntitle: Alpha\nupdatedAt: "2026-01-02"\naliases: [First]\n---\n${ALPHA_BODY}`);
  await put("wiki/queries/question.md", `---\ntitle: Question\ncreatedAt: "2026-01-03"\n---\n${QUESTION_BODY}`);
  await put("wiki/index.md", INDEX_BODY);
  await put("sources/notes.md", "notes\n");
  const state = { version: 1, indexHash: "", sources: { "notes.md": { hash: "RECORDED", concepts: ["alpha"], compiledAt: "t" } } };
  await put(".llmwiki/state.json", JSON.stringify(state));
  const candidate = { id: "pending-one", slug: "pending-one", title: "P", body: "b", sources: [], summary: "", generatedAt: "2026-01-01", reviewMode: "forced" };
  await put(".llmwiki/candidates/pending-one.json", JSON.stringify(candidate));
}

/** The snapshot with its clock value checked and removed. */
async function snapshot(): Promise<Record<string, unknown>> {
  const { generatedAt, ...rest } = await buildViewerSnapshot(root);
  expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
  return rest;
}

/** The two literal pages, as the snapshot carries them. */
function pages(alphaFreshness: string) {
  return [
    {
      id: "concepts/alpha", slug: "alpha", pageDirectory: "concepts", title: "Alpha", filePath: at("wiki/concepts/alpha.md"),
      frontmatter: { title: "Alpha", updatedAt: "2026-01-02", aliases: ["First"] }, body: ALPHA_BODY, aliases: ["First"],
      outgoingLinks: ["queries/question"], danglingLinks: [{ slug: "missing-page", display: "Missing Page" }],
      citations: [{ raw: "notes.md", spans: [{ file: "notes.md" }] }], warnings: [],
      freshness: { freshnessStatus: alphaFreshness, ...FRESHNESS },
    },
    {
      id: "queries/question", slug: "question", pageDirectory: "queries", title: "Question", filePath: at("wiki/queries/question.md"),
      frontmatter: { title: "Question", createdAt: "2026-01-03" }, body: QUESTION_BODY, aliases: [],
      outgoingLinks: ["concepts/alpha"], danglingLinks: [],
      citations: [{ raw: "gone.md:3", spans: [{ file: "gone.md", lines: { start: 3, end: 3 } }] }],
      warnings: [{ code: "unresolved_citation", message: "Source not found: gone.md" }],
      freshness: { freshnessStatus: "unverified", ...FRESHNESS },
    },
  ];
}

const RECENT = [
  { id: "queries/question", pageDirectory: "queries", slug: "question", title: "Question", updatedAt: "2026-01-03" },
  { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha", updatedAt: "2026-01-02" },
];
const GRAPH = {
  nodes: [
    { id: "concepts/alpha", title: "Alpha", slug: "alpha", directory: "concepts", kind: "concept", degree: 2 },
    { id: "queries/question", title: "Question", slug: "question", directory: "queries", kind: "concept", degree: 2 },
    { id: "concepts/missing-page", title: "Missing Page", slug: "missing-page", directory: "concepts", kind: "dangling", degree: 1, isDangling: true },
  ],
  edges: [
    { source: "concepts/alpha", target: "queries/question" }, { source: "concepts/alpha", target: "concepts/missing-page" },
    { source: "queries/question", target: "concepts/alpha" },
  ],
};
const countsOf = (over: Record<string, number>) =>
  ({ concepts: 1, queries: 1, sourceFiles: 1, pendingReviews: 1, compiledSources: 1, stale: 1, orphaned: 0, ...over });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "viewer-snapshot-legacy-")));
  await seed();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the viewer snapshot through its root function, as it behaves today", () => {
  it("L1 builds the whole snapshot of a small project as one literal value", async () => {
    expect(await snapshot()).toEqual({
      root, stateStatus: "ok", project: { title: path.basename(root), rootName: path.basename(root) }, counts: countsOf({}),
      index: { available: true, href: "/#/index", body: INDEX_BODY, outgoingLinks: ["concepts/alpha", "queries/question"] },
      recentPages: RECENT, pages: pages("stale"), sourceFilenames: ["notes.md"], graph: GRAPH,
    });
  });

  it("L2 reports a missing index as unavailable and changes nothing else", async () => {
    await rm(at("wiki/index.md"));
    const built = await snapshot();
    expect(built.index).toEqual({ available: false, href: "/#/index", body: "", outgoingLinks: [] });
    expect(built.pages).toEqual(pages("stale"));
    expect(built.counts).toEqual(countsOf({}));
  });

  it("L3 reads no page and no index through a linked wiki directory", async () => {
    await mkdir(at("elsewhere"));
    await writeFile(at("elsewhere/index.md"), INDEX_BODY);
    await rm(at("wiki"), { recursive: true });
    await symlink(at("elsewhere"), at("wiki"));
    const built = await snapshot();
    expect(built.pages).toEqual([]);
    expect(built.index).toEqual({ available: false, href: "/#/index", body: "", outgoingLinks: [] });
    expect(built.counts).toEqual(countsOf({ concepts: 0, queries: 0, stale: 0 }));
    expect(built.graph).toEqual({ nodes: [], edges: [] });
  });

  it("L4 classifies an unparseable state as corrupt, counts no compiled source and writes no backup", async () => {
    await writeFile(at(".llmwiki/state.json"), "{ not json");
    const built = await snapshot();
    expect(built.stateStatus).toBe("corrupt");
    expect(built.counts).toEqual(countsOf({ compiledSources: 0, stale: 0 }));
    expect(built.pages).toEqual(pages("unverified"));
    expect((await readdir(at(".llmwiki"))).sort()).toEqual(["candidates", "state.json"]);
  });

  it("L5 keeps the four root-named readers' literal answers", async () => {
    expect((await collectRawWikiPages(root)).map((page) => [page.pageDirectory, page.slug, page.filePath])).toEqual([
      ["concepts", "alpha", at("wiki/concepts/alpha.md")], ["queries", "question", at("wiki/queries/question.md")],
    ]);
    expect((await collectViewerPages(root)).map((page) => [page.id, page.outgoingLinks])).toEqual([
      ["concepts/alpha", ["queries/question"]], ["queries/question", ["concepts/alpha"]],
    ]);
    expect(await countCandidates(root)).toBe(1);
    expect(await listSelectedSourceEntries(root)).toEqual(["notes.md"]);
  });
});
