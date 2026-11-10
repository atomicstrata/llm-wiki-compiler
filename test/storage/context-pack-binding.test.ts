/**
 * @file test/storage/context-pack-binding.test.ts
 * @description The WHOLE context-pack consumer, `buildContextPackFrom`, over the
 * bound composition `contextPackReadsOver`, with no project directory. This file
 * uses both, which exist only after the pack was given reads of its own, so it
 * has NO before-edit run.
 *
 * HOW IT IS BUILT. One small default-profile project is minted on real disk,
 * once: two cited concept pages, the cited source, an index, a compile state and
 * a lint cache. The real root `buildContextPack` answers on disk (with
 * `--include-sources`), the disk's embedding-store load outcome and the two
 * directory times are taken, then every regular file's text and every directory
 * listing is COPIED into memory and the directory is removed before any case
 * runs. The cases run the bound composition over that copy and require the pack
 * the disk gave.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The pack body and, under the composition, the
 * REAL lower bodies: the viewer snapshot, the non-default profile gate (over the
 * snapshot's own profile binding), the project state, the semantic step's
 * order, the source-window reader and the journal health warning (over the
 * snapshot's own journal binding). What is replayed: the embedding-store load
 * outcome, the project's real path and the two directory times, each taken
 * from the disk, because the loads are host functions and a copy holds no time.
 *
 * THE ROOT ROUTE IS UNCHANGED. Each root-taking reader is wrapped by a pass-
 * through spy. The disk ask reaches all six; the bound route reaches none.
 *
 * NOT SHOWN HERE: anything the local disk decides (confinement, links, size
 * caps), a non-default profile, a journal that exists, or a usable embedding
 * store. The disk suites (`context-pack`, `context-provenance-integration`,
 * `context-typed-pages`, `journal-health-surfaces`) show those. The doubles are
 * not a hosted store, not an access-control layer and not `ProjectStore`.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "bun:test";
import { passThrough } from "./pass-through-mock.js";
import { buildContextPack, buildContextPackFrom } from "../../src/context/build.js";
import { contextPackReadsOver, type ContextPackReads, type ContextPackSources } from "../../src/context/build-reads.js";
import { materializeSourceWindows, type SourceWindowSources } from "../../src/context/provenance.js";
import { retrieveSemanticChunks } from "../../src/context/retrieval.js";
import type { ContextPack } from "../../src/context/types.js";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import { collectProjectState } from "../../src/project/state.js";
import type { ProjectStateSources } from "../../src/project/state-sources.js";
import { journalHealthWarning } from "../../src/trust/journal-health-warning.js";
import { CONCEPTS_DIR, INDEX_FILE, LAST_LINT_FILE, SOURCES_DIR, STATE_FILE } from "../../src/utils/constants.js";
import { loadEmbeddingsForContext } from "../../src/utils/embeddings-load.js";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedSourceReadsOf, defaultProfileSummaryOf } from "./copied-local-reads.js";
import {
  absentJournalOf, countOf, enoent, entityScansOf, expectRemovedDefaultCopies, heldText, mintCopied, recordDirsOf, recordsOf,
  sourceFreshnessOf, unasked, writeFiles, type Copy, type Minted, type Note,
} from "./copied-project.js";

// Snapshot real modules before mock.module replaces them for this file.
const realSnapshot = { ...(await import("../../src/viewer/snapshot.js")) };
const realBlock = { ...(await import("../../src/profile/block.js")) };
const realState = { ...(await import("../../src/project/state.js")) };
const realRetrieval = { ...(await import("../../src/context/retrieval.js")) };
const realProvenance = { ...(await import("../../src/context/provenance.js")) };
const realJournalHealthWarning = { ...(await import("../../src/trust/journal-health-warning.js")) };

vi.mock("../../src/viewer/snapshot.js", () => passThrough(realSnapshot, "buildViewerSnapshot"));
vi.mock("../../src/profile/block.js", () => passThrough(realBlock, "loadNonDefaultProfile"));
vi.mock("../../src/project/state.js", () => passThrough(realState, "collectProjectState"));
vi.mock("../../src/context/retrieval.js", () => passThrough(realRetrieval, "retrieveSemanticChunks"));
vi.mock("../../src/context/provenance.js", () => passThrough(realProvenance, "materializeSourceWindows"));
vi.mock("../../src/trust/journal-health-warning.js", () => passThrough(realJournalHealthWarning, "journalHealthWarning"));

/** The six root-taking readers the root route calls, in body order. */
const ROOT_READERS = [buildViewerSnapshot, loadNonDefaultProfile, collectProjectState, retrieveSemanticChunks, materializeSourceWindows, journalHealthWarning]
  .map((reader) => reader as unknown as Mock<(...args: never[]) => unknown>);

const PREFIX = "context-pack-binding-";
const REQUEST = { prompt: "alpha beta", includeSources: true, omitRoot: true };
const SEED = {
  [STATE_FILE]: JSON.stringify({ version: 1, indexHash: "", sources: { "paper.md": { hash: "old", concepts: ["alpha"], compiledAt: "2026-01-01T00:00:00.000Z" } } }),
  [LAST_LINT_FILE]: JSON.stringify({ warnings: 1, errors: 0, at: "2026-01-02T00:00:00.000Z" }),
  [`${SOURCES_DIR}/paper.md`]: "Line one.\nLine two.\nLine three.\n",
  [`${CONCEPTS_DIR}/alpha.md`]: "---\ntitle: Alpha\nsummary: First.\n---\n\nAlpha prose links [[Beta]]. ^[paper.md:1-2]\n",
  // Every prompt token must appear in a page for it to rank, so beta names alpha too: both cited pages are primaries.
  [`${CONCEPTS_DIR}/beta.md`]: "---\ntitle: Beta\n---\n\nBeta prose after alpha. ^[paper.md:2-3]\n",
  [INDEX_FILE]: "[[alpha]] [[beta]]\n",
};

/** What the disk answered, and what a copy cannot hold: the real path, the store load and the two directory times. */
interface OnDisk { pack: ContextPack; real: string; embeddings: Awaited<ReturnType<typeof loadEmbeddingsForContext>>; times: Record<string, number> }

const tracker = tempRootTracker();
let minted: Minted<OnDisk>;
let rootReached: boolean[];

/** The disk's answer for the project at `root`, with what the memory side must replay. */
async function askDisk(root: string): Promise<OnDisk> {
  const pack = await buildContextPack({ root, ...REQUEST });
  const time = async (rel: string): Promise<number> => (await stat(path.join(root, rel))).mtimeMs;
  return { pack, real: await realpath(root), embeddings: await loadEmbeddingsForContext(root), times: { wiki: await time("wiki"), [SOURCES_DIR]: await time(SOURCES_DIR) } };
}

beforeAll(async () => {
  ROOT_READERS.forEach((reader) => reader.mockClear());
  minted = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, SEED), askDisk);
  rootReached = ROOT_READERS.map((reader) => reader.mock.calls.length > 0);
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());

/** The project-state probes over the copy: a held directory or file, its replayed time, a listing, a held text. */
function stateSourcesOf(copy: Copy, times: Record<string, number>, note: Note): ProjectStateSources {
  const probes: ProjectStateSources["probes"] = {
    probeRoot: async () => { note("root"); return { isDirectory: true, isFile: false, modifiedMs: 0 }; },
    probe: async (rel) => {
      note(`probe ${rel}`);
      const isDirectory = copy.listings.has(rel);
      return isDirectory || copy.files.has(rel) ? { isDirectory, isFile: !isDirectory, modifiedMs: times[rel] ?? 0 } : null;
    },
    listEntries: async (relDir) => {
      note(`list ${relDir}`);
      const held = copy.listings.get(relDir);
      if (held === undefined) throw enoent();
      return held.map((entry) => ({ name: entry.name, isFile: entry.kind === "file" }));
    },
    readText: async (rel) => { note(`read ${rel}`); return heldText(copy, rel); },
  };
  return { root: "/display/only", probes, reads: copiedSourceReadsOf(copy, note), candidateDirs: recordDirsOf(copy, note), records: recordsOf(copy, note) };
}

/** The cited-window sources over the copy: a source is located when the copy holds it under `sources/`. */
function windowSourcesOf(copy: Copy, note: Note): SourceWindowSources {
  return { openSources: async () => { note("open"); return copy.listings.has(SOURCES_DIR) ? {
    locateSource: async (file) => { note(`locate ${file}`); return copy.files.has(`${SOURCES_DIR}/${file}`) ? `${SOURCES_DIR}/${file}` : null; },
    readText: async (token) => { note(`read ${token}`); return heldText(copy, token); },
  } : null; } };
}

/** Every seam over the copy, each call logged as `<seam>:<call>`. */
function sourcesOf(log: string[]): ContextPackSources {
  const { copy, onDisk } = minted;
  const note = (seam: string): Note => (call) => { log.push(`${seam}:${call}`); };
  const snap = note("snapshot");
  return {
    snapshot: { root: "/display/only", bindings: {
      ...defaultProfileSummaryOf(copy, snap), scans: entityScansOf(copy, onDisk.real, snap),
      records: recordsOf(copy, snap), candidateDirs: recordDirsOf(copy, snap), reads: copiedSourceReadsOf(copy, snap),
      readIndexText: async () => { snap("index"); return heldText(copy, INDEX_FILE); },
      freshness: sourceFreshnessOf(copy, snap), journal: absentJournalOf(note("journal")),
    } },
    state: stateSourcesOf(copy, onDisk.times, note("state")),
    pages: { reads: copiedSourceReadsOf(copy, note("pages")), scans: entityScansOf(copy, onDisk.real, note("pages")) },
    loads: { embeddings: async () => { log.push("semantic:embeddings"); return onDisk.embeddings; }, profile: unasked("loads.profile") },
    windows: windowSourcesOf(copy, note("windows")),
  };
}

/** The reads, each member's name logged to `calls` before it runs. */
function recorded(reads: ContextPackReads, calls: string[]): ContextPackReads {
  return Object.fromEntries(Object.entries(reads).map(([name, read]) =>
    [name, (...args: unknown[]) => { calls.push(name); return (read as (...given: unknown[]) => unknown)(...args); }])) as unknown as ContextPackReads;
}

describe("the context pack over a copied project, with the directory gone", () => {
  it("C1 runs after the minting directory was removed, on a copy holding no journal and no binding leaf", () => {
    expectRemovedDefaultCopies([minted], PREFIX);
  });

  it("C2 answers exactly the pack the disk gave, source windows included", async () => {
    const pack = await buildContextPackFrom(contextPackReadsOver(sourcesOf([])), REQUEST);
    expect(pack).toEqual(minted.onDisk.pack);
    // The case is only a witness of the window reads when both cited primaries got a window.
    expect(pack.primary.map((entry) => entry.sourceWindows.length > 0)).toEqual([true, true]);
  });
});

describe("the reads one pack makes", () => {
  it("C3 reads snapshot, profile, state, semantic, one window read per primary, then the journal through the snapshot's binding", async () => {
    const calls: string[] = [], log: string[] = [];
    await buildContextPackFrom(recorded(contextPackReadsOver(sourcesOf(log)), calls), REQUEST);
    expect(calls).toEqual(["snapshot", "nonDefaultProfile", "projectState", "semantic", "sourceWindows", "sourceWindows", "journalWarning"]);
    expect([log.at(-1), countOf(log, "journal:journal.open")]).toEqual(["journal:journal.open", 2]);
    expect(log.indexOf("semantic:embeddings")).toBeLessThan(log.indexOf("windows:open"));
    expect(log.some((call) => call.startsWith("pages:"))).toBe(false);
  });

  it("C4 makes no window read without --include-sources, and loads no store for zero chunks", async () => {
    const calls: string[] = [], log: string[] = [];
    await buildContextPackFrom(recorded(contextPackReadsOver(sourcesOf(log)), calls), { prompt: "alpha", topChunks: 0 });
    expect(calls).toEqual(["snapshot", "nonDefaultProfile", "projectState", "semantic", "journalWarning"]);
    expect(log.filter((call) => call.startsWith("windows:") || call.startsWith("semantic:"))).toEqual([]);
  });

  it("C5 the root route reached all six root readers; the bound route reaches none", async () => {
    expect(rootReached).toEqual(ROOT_READERS.map(() => true));
    ROOT_READERS.forEach((reader) => reader.mockClear());
    await buildContextPackFrom(contextPackReadsOver(sourcesOf([])), REQUEST);
    expect(ROOT_READERS.map((reader) => reader.mock.calls.length)).toEqual(ROOT_READERS.map(() => 0));
  });
});
