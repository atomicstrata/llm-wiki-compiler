/**
 * @file test/storage/source-review-binding.test.ts
 * @description The viewer's source-review cockpit as ONE body over its reads,
 * `collectSourceReviewFrom`, with no project directory; with it, the
 * fault-isolated freshness (`reviewFreshnessFrom`) and the excerpt reader
 * (`sourceExcerptReaderFrom`) it composes. This file uses them, which exist only
 * after the review was given reads of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once: a compiled state
 * with a changed, a kept and a deleted source, a concept page for the changed
 * source, none for the deleted one, and one pending candidate for a page that
 * does not exist. The real
 * `collectSourceReview(root)` answers on disk, the tree is copied into memory,
 * and the directory is removed before any case runs. The memory side runs every
 * REAL body over the copy: the classified state, the freshness snapshot under
 * the review's isolation, the candidate page, the viewer source read under the
 * excerpt reader, and the confined concept read.
 *
 * THE ROOT ROUTE IS UNCHANGED. The six root readers are spied: the bound route
 * reaches none, and a fresh project reviewed through `collectSourceReview`
 * reaches each with its exact arguments.
 *
 * NOT SHOWN HERE: the cockpit route, confinement, a symlinked or unreadable page
 * (absence is ENOENT only, decided by the local read), and the per-source
 * fallback after a snapshot fault; the source-review suites show those. The
 * doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as candidateRead from "../../src/compiler/candidate-read.js";
import { writeCandidate } from "../../src/compiler/candidates.js";
import * as confinedWikiRead from "../../src/compiler/confined-wiki-read.js";
import { buildFreshnessSnapshotFrom } from "../../src/freshness/index.js";
import type { LegacyLocalCappedReads } from "../../src/storage/legacy-local-reads.js";
import * as diskLocalReads from "../../src/storage/disk-local-reads.js";
import { CONCEPTS_DIR, SOURCES_DIR, STATE_FILE } from "../../src/utils/constants.js";
import * as stateRecords from "../../src/utils/state.js";
import { readViewerSourceFrom } from "../../src/viewer/source-access.js";
import * as reviewFreshness from "../../src/viewer/source-review/freshness.js";
import { collectSourceReview, collectSourceReviewFrom, type SourceReviewReads } from "../../src/viewer/source-review/report.js";
import * as sourceExcerpts from "../../src/viewer/source-review/source-excerpts.js";
import { sha256Hex as sha } from "../fixtures/state-json.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedLocalReadsOf } from "./copied-local-reads.js";
import { heldText, mintCopied, recordDirsOf, recordsOf, sourceFreshnessOf, writeFiles, type Copy, type Minted } from "./copied-project.js";
import { compiledEntry, KEPT_TEXT, page } from "./compiled-seed.js";

const PREFIX = "source-review-binding-";
const FILES = {
  [STATE_FILE]: JSON.stringify({ version: 1, indexHash: "", sources: {
    "changed.md": compiledEntry("OLD", ["alpha"]),
    "kept.md": compiledEntry(sha(KEPT_TEXT), ["beta"]),
    "gone.md": compiledEntry("G", ["gamma"]),
  } }),
  [`${SOURCES_DIR}/changed.md`]: "---\ntitle: Changed\n---\nChanged since compile.\n", [`${SOURCES_DIR}/kept.md`]: KEPT_TEXT,
  [`${CONCEPTS_DIR}/alpha.md`]: page("title: Alpha"), [`${CONCEPTS_DIR}/beta.md`]: page("title: Beta"),
};
/** The project: the files, then one pending candidate for a page that does not exist yet. */
async function seed(root: string): Promise<void> {
  await writeFiles(root, FILES);
  await writeCandidate(root, { title: "Delta", slug: "delta", summary: "", sources: ["changed.md"], body: "---\ntitle: Delta\n---\n\nNew.\n" });
}

/** A review without its observation instant, which is the one field that differs between two runs. */
const timeless = ({ observedAt: _at, ...rest }: Awaited<ReturnType<typeof collectSourceReview>>): unknown => rest;

const tracker = tempRootTracker();
let minted: Minted<{ review: unknown; displayRoot: string }>;

beforeAll(async () => {
  minted = await mintCopied(tracker, PREFIX, seed, async (root) => ({ review: timeless(await collectSourceReview(root)), displayRoot: path.resolve(root) }));
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** The copy's bounded source reads, as the viewer source read asks them. */
const cappedReadsOf = (copy: Copy, note: (call: string) => void): LegacyLocalCappedReads => ({
  readCappedText: async (rel) => { note(`read ${rel}`); return copy.files.has(rel) ? { kind: "ok", body: heldText(copy, rel) } : { kind: "absent" }; },
});

/** Every review read over the copy, each its real body; every call is logged as `<read>:<call>`. */
function readsOf(copy: Copy, log: string[]): SourceReviewReads {
  const note = (read: string) => (call: string): void => { log.push(`${read}:${call}`); };
  return {
    readState: () => stateRecords.readStateClassifiedFrom(recordsOf(copy, note("state"))),
    freshness: (classified) => reviewFreshness.reviewFreshnessFrom((one) => buildFreshnessSnapshotFrom(sourceFreshnessOf(copy, note("freshness")), one), classified),
    candidatePage: (limit) => candidateRead.listCandidateIdentityPageFrom(recordDirsOf(copy, note("candidates")), limit),
    excerptReader: (files) => sourceExcerpts.sourceExcerptReaderFrom((file) => readViewerSourceFrom(cappedReadsOf(copy, note("excerpt")), files, file, true)),
    readConcept: (slug) => copiedLocalReadsOf(copy, note("concept")).readConfinedPage(CONCEPTS_DIR, slug),
    conceptAbsent: async (slug) => { log.push(`absent:${slug}`); return !copy.files.has(`${CONCEPTS_DIR}/${slug}.md`); },
  };
}

describe("the source review over a copied project, with the directory gone", () => {
  it("V1 reviews the project exactly as the disk did, the displayed root included", async () => {
    expect(timeless(await collectSourceReviewFrom(readsOf(minted.copy, []), minted.onDisk.displayRoot))).toEqual(minted.onDisk.review);
    // The case only witnesses each rule when the disk applied it.
    expect(minted.onDisk.review).toMatchObject({ stateStatus: "ok", totalPages: 3, candidateTotal: 1, candidateShown: 1, omittedUnsafeSlugs: 0 });
    const pages = (minted.onDisk.review as { pages: Array<{ slug: string; readStatus: string; excerpts: Array<{ status: string }> }> }).pages;
    expect(pages.map((page) => [page.slug, page.readStatus])).toEqual([["alpha", "readable"], ["delta", "Page does not exist yet"], ["gamma", "Page does not exist yet"]]);
    expect(pages[0]!.excerpts.map((excerpt) => excerpt.status)).toEqual(["available"]);
  });

  it("V2 reads state, freshness and the candidate page first, then each page's text before its absence", async () => {
    const log: string[] = [];
    await collectSourceReviewFrom(readsOf(minted.copy, log), minted.onDisk.displayRoot);
    const first = (prefix: string): number => log.findIndex((call) => call.startsWith(prefix));
    expect(first("state:")).toBe(0);
    expect([first("state:") < first("freshness:"), first("freshness:") < first("candidates:"), first("candidates:") < first("concept:")]).toEqual([true, true, true]);
    expect(log.filter((call) => call.startsWith("concept:") || call.startsWith("absent:"))).toEqual([
      `concept:page ${CONCEPTS_DIR}/alpha.md`, "absent:alpha", `concept:page ${CONCEPTS_DIR}/delta.md`, "absent:delta",
      `concept:page ${CONCEPTS_DIR}/gamma.md`, "absent:gamma",
    ]);
  });

  it("V3 reaches no root reader from the bound route, while the root route reaches each with its exact arguments", async () => {
    const spies = [vi.spyOn(stateRecords, "readStateClassified"), vi.spyOn(reviewFreshness, "reviewFreshness"),
      vi.spyOn(candidateRead, "listCandidateIdentityPage"), vi.spyOn(sourceExcerpts, "sourceExcerptReader"),
      vi.spyOn(confinedWikiRead, "readConfinedWikiPage"), vi.spyOn(diskLocalReads, "locationKindNoFollow")];
    await collectSourceReviewFrom(readsOf(minted.copy, []), minted.onDisk.displayRoot);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    const root = await tracker.create(PREFIX);
    await seed(root);
    await collectSourceReview(root);
    const pageCalls = (slug: string) => [root, CONCEPTS_DIR, slug];
    expect(spies.map((spy) => spy.mock.calls)).toEqual([
      [[root]], [[root, expect.objectContaining({ status: "ok" })]], [[root, 100]], [[root, ["changed.md", "kept.md", "gone.md"]]],
      [pageCalls("alpha"), pageCalls("delta"), pageCalls("gamma")],
      ["alpha", "delta", "gamma"].map((slug) => [path.join(root, CONCEPTS_DIR, `${slug}.md`)]),
    ]);
  });
});
