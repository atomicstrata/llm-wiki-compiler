/**
 * @file test/storage/page-record-binding.test.ts
 * @description The MCP `wiki_read_page` page record, `readPageRecordFrom`, and
 * the confined page text under it, `readPageContentFrom`, over the confined page
 * read alone, with no project directory. This file uses them, which exist only
 * after the page read was given a read of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once: a titled concept,
 * an untitled concept, a page saved only as a query, and a slug whose concept is
 * orphaned while its query is not. The real `readPageRecord(root, slug)` answers
 * a fixed set of slugs on disk (including a slug with a separator and a missing
 * one), the tree is copied into memory, and the directory is removed before any
 * case runs. Each case asks the same slugs of the body over the copy.
 *
 * THE ROOT ROUTE IS UNCHANGED. The incumbent confined read is spied: the bound
 * route reaches it never, and a fresh project read through `readPageRecord`
 * reaches it with exact arguments, concepts before queries.
 *
 * NOT SHOWN HERE: what the disk decides (a page that escapes its directory, a
 * symlink, links); `mcp-resource-confinement.test.ts` and the confined-read
 * suites show those. The doubles are not a hosted store, not an access-control
 * layer and not `ProjectStore`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as confinedWikiRead from "../../src/compiler/confined-wiki-read.js";
import { readPageContentFrom, readPageRecord, readPageRecordFrom, type PageContentReads, type PageRecord } from "../../src/pages/read.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedLocalReadsOf } from "./copied-local-reads.js";
import { expectRemovedDefaultCopies, mintCopied, writeFiles, type Copy, type Minted } from "./copied-project.js";

const PREFIX = "page-record-binding-";
const page = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n\n${body}\n`;
const SEED = {
  [`${CONCEPTS_DIR}/alpha.md`]: page("title: Alpha\nsummary: First.", "Alpha body."),
  [`${CONCEPTS_DIR}/untitled.md`]: page("summary: No title.", "Untitled body."),
  [`${QUERIES_DIR}/asked.md`]: page("title: Asked", "Asked body."),
  [`${CONCEPTS_DIR}/both.md`]: page("title: Old Both\norphaned: true", "Orphaned concept."),
  [`${QUERIES_DIR}/both.md`]: page("title: Both", "Live query."),
};
/** The slugs every case asks, in this order: a separator and a missing slug read as absent. */
const SLUGS = ["alpha", "untitled", "asked", "both", "a/b", "missing"];

const tracker = tempRootTracker();
let minted: Minted<Array<PageRecord | null>>;

beforeAll(async () => {
  minted = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, SEED),
    async (root) => Promise.all(SLUGS.map((slug) => readPageRecord(root, slug))));
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** The confined page read over the copy; every read is logged as `page <dir>/<slug>.md`. */
const readsOf = (copy: Copy, log: string[]): PageContentReads => copiedLocalReadsOf(copy, (call) => { log.push(call); });

describe("the page record over a copied project, with the directory gone", () => {
  it("P1 runs after the minting directory was removed", () => {
    expectRemovedDefaultCopies([minted], PREFIX);
  });

  it("P2 answers every slug exactly as the disk did", async () => {
    const reads = readsOf(minted.copy, []);
    expect(await Promise.all(SLUGS.map((slug) => readPageRecordFrom(reads, slug)))).toEqual(minted.onDisk);
    // The case only witnesses each rule when the disk applied it.
    expect(minted.onDisk.map((record) => record?.title ?? null)).toEqual(["Alpha", "untitled", "Asked", "Both", null, null]);
    expect(minted.onDisk[1]?.summary).toBe("No title.");
  });

  it("P3 reads concepts before queries, stops at the first live page, and reads nothing for a refused slug", async () => {
    const readsFor = async (slug: string): Promise<string[]> => {
      const log: string[] = [];
      await readPageRecordFrom(readsOf(minted.copy, log), slug);
      return log;
    };
    expect(await readsFor("alpha")).toEqual([`page ${CONCEPTS_DIR}/alpha.md`]);
    expect(await readsFor("both")).toEqual([`page ${CONCEPTS_DIR}/both.md`, `page ${QUERIES_DIR}/both.md`]);
    expect(await readsFor("a/b")).toEqual([]);
    const refused: string[] = [];
    expect(await readPageContentFrom(readsOf(minted.copy, refused), CONCEPTS_DIR, "")).toBeNull();
    expect(refused).toEqual([]);
  });

  it("P4 reaches no confined read from the bound route, while the root route reaches it with exact arguments", async () => {
    const confined = vi.spyOn(confinedWikiRead, "readConfinedWikiPage");
    await readPageRecordFrom(readsOf(minted.copy, []), "asked");
    expect(confined.mock.calls).toEqual([]);
    const root = await tracker.create(PREFIX);
    await writeFiles(root, SEED);
    expect((await readPageRecord(root, "asked"))?.title).toBe("Asked");
    expect(confined.mock.calls).toEqual([[root, CONCEPTS_DIR, "asked"], [root, QUERIES_DIR, "asked"]]);
  });
});
