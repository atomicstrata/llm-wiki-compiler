/**
 * @file test/catalog/listing.test.ts
 * @description The catalog serving the ORDINARY SDK listings of an active
 * `local-indexed` project on real disk: keyset pages after a restart with no
 * body reads and counters independent of the corpus size; the same `Page`
 * and `SourceRecord` projections the legacy listings return; and the legacy
 * route left exactly as it was on a project that is not indexed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { openCatalog } from "../../src/catalog/meta.js";
import { routedListPages, routedListSources } from "../../src/catalog/routes.js";
import { listPages, type Page } from "../../src/pages/list.js";
import { newCounters, observeIo } from "../../src/segments/counters.js";
import { listSources } from "../../src/sources/store.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { activateIndexed, writeCorpus } from "./helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-catalog-list-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Every page through the routed listing, page by page. */
async function allRoutedPages(limit: number): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const result = await routedListPages(root, { limit, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(...result.pages);
    cursor = result.cursor;
  } while (cursor !== undefined);
  return pages;
}

/** The counters of one first page of 50 from a fresh `count`-page indexed project. */
async function measureFirstPage(count: number) {
  await writeCorpus(root, count, 10);
  await activateIndexed(root);
  const counters = newCounters();
  const result = await observeIo(counters, () => createWikiCore({ root }).listPages({ limit: 50 }));
  expect(result.pages).toHaveLength(50);
  expect(result.cursor).toBeDefined();
  // Work is bounded by the run count (each scan holds one segment per run), never by the page count.
  const runs = (await openCatalog(root)).manifest.runs.length;
  expect(counters.segmentsOpened).toBeLessThanOrEqual(2 * runs + 2);
  expect(counters.blocksRead).toBeLessThanOrEqual(2 * runs + 2);
  return counters;
}

describe("bounded keyset work", () => {
  it("serves one page after a restart with no body reads, and the same work at 300 and 1200 pages", async () => {
    const small = await measureFirstPage(300);
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(path.join(tmpdir(), "llmwiki-catalog-list-"));
    const large = await measureFirstPage(1200);
    expect([small.bodiesRead, large.bodiesRead]).toEqual([0, 0]);
    expect(large.filesStatted).toBe(small.filesStatted);
    expect(large.rowsDecoded).toBeLessThan(1200);
    expect(large.rowsReturned).toBe(50);
  });
});

describe("keyset pages from the catalog", () => {

  it("walks every page by cursor, matching the legacy projection field for field in key order", async () => {
    await writeCorpus(root, 120, 0);
    const legacy = (await listPages(root)).pages;
    await activateIndexed(root);
    const indexed = await allRoutedPages(17);
    const byKey = (page: Page) => `${page.pageDirectory}/${page.slug}`;
    expect(indexed.map(byKey)).toEqual([...legacy].map(byKey).sort());
    expect(indexed).toEqual([...legacy].sort((a, b) => (byKey(a) < byKey(b) ? -1 : 1)));
  });

  it("serves sources with the legacy fields, bodies only on request, and refuses a numeric offset cursor", async () => {
    await writeCorpus(root, 0, 30);
    const legacy = (await listSources(root, { includeBody: true })).sources;
    await activateIndexed(root);
    const first = await routedListSources(root, { limit: 10, includeBody: true });
    expect(first.sources).toEqual(legacy.slice(0, 10));
    await expect(routedListSources(root, { cursor: "10" })).rejects.toThrow("invalid listSources cursor");
  });
});

describe("a project that is not indexed", () => {
  it("keeps the legacy listing exactly and creates no indexed store", async () => {
    await writeCorpus(root, 20, 5);
    expect(await routedListPages(root, { limit: 7 })).toEqual(await listPages(root, { limit: 7 }));
    expect(await routedListSources(root)).toEqual(await listSources(root));
    await expect(import("node:fs/promises").then((fs) => fs.lstat(path.join(root, ".llmwiki", "indexed")))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
