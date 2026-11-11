/**
 * @file test/storage/status-consumer-binding.test.ts
 * @description The WHOLE status consumer, `collectStatusFrom`, with no project
 * directory. This file uses `collectStatusFrom`, `scanWikiPagesFrom`,
 * `collectPageSummariesFrom` and the two embedding-warning `...From` mappers,
 * which exist only after the status collector was given reads of its own, so
 * it has NO before-edit run.
 *
 * HOW IT IS BUILT. Three small projects are minted on real disk, once: a
 * compiled project with drift, a project whose state is too new and whose
 * pending marker is corrupt, and an empty directory. For each, the real
 * `collectStatus(root)` answers on disk, then every regular file's text and
 * every directory listing is COPIED into memory, and the directories are
 * removed before any case runs. Each case then runs `collectStatusFrom` over
 * that copy and requires the same answer the disk gave.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The status body, and under it the REAL lower
 * bodies: the classified state read, the freshness snapshot, the page scan and
 * its summaries, the candidate count, the selected-source listing with the
 * project-configuration read, the profile summary's default gate, the journal
 * health warning and both embedding-marker warnings with the marker parse. No
 * status answer and no lower answer is replayed or written by hand.
 *
 * WHAT THE DOUBLES DECIDE. Only what a copy can: whether a path is held, what a
 * directory lists, and what a held file's text is. The profile binding leaf is
 * answered `absent` by the shared `noBindingLeafDouble`, and the journal is
 * answered `absent`; the first case shows the copies hold neither. Every double
 * logs its call, under the step of the status body it belongs to.
 *
 * NOT SHOWN HERE: anything the local disk decides. Confinement of a page, a
 * marker or a source under the project, links, special files, size caps, the
 * no-follow opens, a non-default profile and a journal that exists are shown
 * only by the disk tests (`pending-embeddings-status.test.ts`,
 * `quarantined-embeddings-surfaces.test.ts`, `freshness-mcp-status.test.ts`,
 * `journal-health-surfaces.test.ts`, `profile-status.test.ts`).
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { collectStatus, collectStatusFrom, statusReadsOver, type StatusReads, type StatusSources, type WikiStatus } from "../../src/status/collect.js";
import {
  CONCEPTS_DIR, MAX_PENDING_EMBEDDING_ATTEMPTS, PENDING_EMBEDDINGS_FILE,
  QUARANTINED_EMBEDDINGS_FILE, QUERIES_DIR, SOURCES_DIR, STATE_FILE,
} from "../../src/utils/constants.js";
import { writePendingEmbeddings, type EmbeddingMarkerReads, type MarkerTextRead } from "../../src/utils/pending-embeddings.js";
import { sha256Hex as sha } from "../fixtures/state-json.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  absentJournalOf, countOf, expectRemovedDefaultCopies, heldText, mintCopied, pageScanOf, recordDirsOf, recordsOf,
  sourceFreshnessOf, stepsOf, writeFiles, type Copy, type Minted,
} from "./copied-project.js";
import { copiedSourceReadsOf, defaultProfileSummaryOf } from "./copied-local-reads.js";
import { KEPT_TEXT, page } from "./compiled-seed.js";

const PREFIX = "status-consumer-";
const LAST_COMPILE = "2026-01-03T00:00:00.000Z";

const tracker = tempRootTracker();
let compiled: Minted<WikiStatus>;
let unusable: Minted<WikiStatus>;
let empty: Minted<WikiStatus>;

/** Mint one project with `seed`, take the disk's status answer and a copy; the tracker removes the directory later. */
const mint = (seed: (root: string) => Promise<void>): Promise<Minted<WikiStatus>> => mintCopied(tracker, PREFIX, seed, collectStatus);

/** A compiled project with drift: a kept, a changed, a deleted and a new source; five concept pages; one query; one candidate; both markers. */
async function seedCompiled(root: string): Promise<void> {
  const entry = (hash: string, concept: string, day: number) => ({ hash, concepts: [concept], compiledAt: `2026-01-0${day}T00:00:00.000Z` });
  const sources = { "kept.md": entry(sha(KEPT_TEXT), "alpha", 1), "changed.md": entry("OLD", "beta", 2), "gone.md": entry("G", "gamma", 3) };
  await writeFiles(root, {
    [STATE_FILE]: JSON.stringify({ version: 1, indexHash: "", sources }),
    [`${SOURCES_DIR}/kept.md`]: KEPT_TEXT, [`${SOURCES_DIR}/changed.md`]: "Changed since compile.\n",
    [`${SOURCES_DIR}/new.md`]: "Never compiled.\n", [`${SOURCES_DIR}/notes.txt`]: "Not Markdown.\n",
    [`${CONCEPTS_DIR}/alpha.md`]: page("title: Alpha\nsummary: First."), [`${CONCEPTS_DIR}/beta.md`]: page("title: Beta"),
    [`${CONCEPTS_DIR}/gamma.md`]: page("title: Gamma"), [`${CONCEPTS_DIR}/untitled.md`]: page("summary: No title."),
    [`${CONCEPTS_DIR}/flagged.md`]: page("title: Flagged\norphaned: true"), [`${CONCEPTS_DIR}/README.txt`]: "Not a page.\n",
    [`${QUERIES_DIR}/saved.md`]: page("title: Saved"),
  });
  await writeCandidate(root, { title: "delta", slug: "delta", summary: "", sources: [], body: page("title: delta") });
  await writePendingEmbeddings(root, [{ pageId: "concepts/alpha", attempts: 0 }]);
  await writePendingEmbeddings(root, [{ pageId: "concepts/gamma", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS }], QUARANTINED_EMBEDDINGS_FILE);
}

/** A project this version cannot read: a too-new state, a corrupt pending marker, one source, no wiki. */
function seedUnusable(root: string): Promise<void> {
  return writeFiles(root, {
    [STATE_FILE]: JSON.stringify({ version: 99 }), [PENDING_EMBEDDINGS_FILE]: "{not json", [`${SOURCES_DIR}/a.md`]: "A.\n",
  });
}

beforeAll(async () => {
  compiled = await mint(seedCompiled);
  unusable = await mint(seedUnusable);
  empty = await mint(async () => {});
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());

/** The status sources over one copy. They answer only what the copy holds, and log each call as `<step>:<call>`. */
function doublesOf(copy: Copy, log: string[]): StatusSources {
  const note = (step: string) => (call: string): void => { log.push(`${step}:${call}`); };
  const state = note("state"), fresh = note("freshness"), content = note("content"), profile = note("profile"), warn = note("warnings");
  const text = (rel: string): string => heldText(copy, rel);
  const records = recordsOf(copy, state);
  const freshness = sourceFreshnessOf(copy, fresh);
  const scan = (relDir: string) => pageScanOf(copy, relDir, content);
  const candidates = recordDirsOf(copy, content);
  const markers: EmbeddingMarkerReads = { readMarkerText: async (markerFile): Promise<MarkerTextRead> => {
    warn(`marker ${markerFile}`);
    return copy.files.has(markerFile) ? { kind: "ok", body: text(markerFile) } : { kind: "absent" };
  } };
  return {
    records, freshness, concepts: scan(CONCEPTS_DIR), queries: scan(QUERIES_DIR), candidates, markers,
    journal: absentJournalOf(warn), sourceFiles: copiedSourceReadsOf(copy, content), profile: defaultProfileSummaryOf(copy, profile),
  };
}

/** The status reads over one copy: the production composition, each member the REAL lower body over a double. */
function statusReadsOf(copy: Copy, log: string[] = []): StatusReads {
  return statusReadsOver(doublesOf(copy, log));
}

describe("the status consumer over copied projects, with the directories gone", () => {
  it("S1 runs after every minting directory was removed, on copies holding no journal, binding leaf or profile", () => {
    expectRemovedDefaultCopies([compiled, unusable, empty], PREFIX);
  });

  it("S2 answers a compiled project with drift exactly as the disk did, key for key", async () => {
    const inMemory = await collectStatusFrom(statusReadsOf(compiled.copy));
    expect(inMemory).toEqual(compiled.onDisk);
    expect(Object.keys(inMemory)).toEqual(Object.keys(compiled.onDisk));
    expect(inMemory).toMatchObject({
      pages: { concepts: 3, queries: 1, total: 4 }, sources: 3, lastCompiledAt: LAST_COMPILE, stateStatus: "ok",
      stalePages: ["beta"], staleCount: 1, orphanedPages: ["flagged", "gamma"], orphanedCount: 2, pendingCandidates: 1,
      pendingChanges: [{ file: "changed.md", status: "changed" }, { file: "gone.md", status: "deleted" }, { file: "new.md", status: "new" }],
      pendingChangesCount: 3,
    });
    expect(inMemory.warnings?.map((warning) => warning.code)).toEqual(["embeddings-refresh-pending", "embeddings-refresh-quarantined"]);
    expect("profile" in inMemory).toBe(false);
  });

  it("S3 answers a too-new state with a corrupt marker exactly as the disk did, suppressing pending changes", async () => {
    const inMemory = await collectStatusFrom(statusReadsOf(unusable.copy));
    expect(inMemory).toEqual(unusable.onDisk);
    expect(Object.keys(inMemory)).toEqual(Object.keys(unusable.onDisk));
    expect(inMemory).toMatchObject({
      pages: { concepts: 0, queries: 0, total: 0 }, sources: 0, lastCompiledAt: null, stateStatus: "too-new",
      pendingChanges: [], pendingChangesCount: 0,
    });
    expect(inMemory.warnings?.map((warning) => warning.code)).toEqual(["embeddings-refresh-unavailable"]);
  });

  it("S4 answers an empty project exactly as the disk did, with no warnings key and no profile key", async () => {
    const inMemory = await collectStatusFrom(statusReadsOf(empty.copy));
    expect(inMemory).toEqual(empty.onDisk);
    expect(Object.keys(inMemory)).toEqual(Object.keys(empty.onDisk));
    expect([inMemory.stateStatus, "warnings" in inMemory, "profile" in inMemory]).toEqual(["missing", false, false]);
  });
});

describe("the reads one status snapshot makes over a copy", () => {
  it("S5 takes the five steps in order: state, freshness, content, profile, warnings", async () => {
    const log: string[] = [];
    await collectStatusFrom(statusReadsOf(compiled.copy, log));
    expect(stepsOf(log)).toEqual(["state", "freshness", "content", "profile", "warnings"]);
    expect(log.slice(0, 3)).toEqual([`state:exists ${STATE_FILE}`, `state:read ${STATE_FILE}`, "freshness:open"]);
  });

  it("S6 scans the concept and query directories once each, reading each page once", async () => {
    const log: string[] = [];
    await collectStatusFrom(statusReadsOf(compiled.copy, log));
    expect([countOf(log, `content:list ${CONCEPTS_DIR}`), countOf(log, `content:list ${QUERIES_DIR}`)]).toEqual([1, 1]);
    const conceptPages = ["alpha", "beta", "flagged", "gamma", "untitled"];
    expect(conceptPages.map((slug) => countOf(log, `content:page ${CONCEPTS_DIR}/${slug}`))).toEqual([1, 1, 1, 1, 1]);
    expect([countOf(log, `content:page ${QUERIES_DIR}/saved`), countOf(log, `content:page ${CONCEPTS_DIR}/README.txt`)]).toEqual([1, 0]);
  });

  it("S7 opens the journal once and reads each marker twice, once for each embedding warning", async () => {
    const log: string[] = [];
    await collectStatusFrom(statusReadsOf(compiled.copy, log));
    const warnings = log.filter((call) => call.startsWith("warnings:"));
    expect(warnings.length).toBe(5);
    expect(["journal.open", `marker ${PENDING_EMBEDDINGS_FILE}`, `marker ${QUARANTINED_EMBEDDINGS_FILE}`].map((call) => countOf(log, `warnings:${call}`))).toEqual([1, 2, 2]);
  });

  it("S8 makes no source call for a too-new state, and still lists sources and reads both markers", async () => {
    const log: string[] = [];
    await collectStatusFrom(statusReadsOf(unusable.copy, log));
    expect(stepsOf(log)).toEqual(["state", "content", "profile", "warnings"]);
    expect([countOf(log, `content:directory ${SOURCES_DIR}`), log.filter((call) => call.startsWith("warnings:marker")).length]).toEqual([1, 4]);
  });
});
