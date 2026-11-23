/**
 * @file test/vectors/search.test.ts
 * @description Piecewise vectors of an active `local-indexed` project on real
 * disk, through the incumbent search pipeline: the same top-K pages and
 * chunks (and stale reports) as the whole-store pipeline on the same data;
 * stale high scorers, more than any fixed overfetch, never crowd out fresh
 * lower ones; same slugs across namespaces and chunk-index ties keep the
 * incumbent tie order; a refresh after one page changes re-embeds and
 * rewrites only that page's pieces; the retained backup is never read.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { restoreEnv, restoreGlobals } from "../stubs.js";
import { findRelevantChunksV3, findRelevantPagesV3, loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { updateEmbeddings } from "../../src/utils/embeddings.js";
import { newCounters, observeIo } from "../../src/segments/counters.js";
import type { PageId } from "../../src/utils/page-id.js";
import { asPageMetaRow } from "../../src/vectors/codec.js";
import { chunkVectorKey } from "../../src/vectors/contracts.js";
import { openVectorStore, vectorMetaOf } from "../../src/vectors/store.js";
import { activateIndexed } from "../catalog/helpers.js";
import { embedded, useOfflineEmbeddings, writePage } from "./helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-vectors-")); useOfflineEmbeddings(); });
afterEach(async () => { vi.restoreAllMocks(); restoreEnv(); restoreGlobals(); await rm(root, { recursive: true, force: true }); });

const QUESTION = "what about topic seven";

/** Write the corpus and namesake pair, optionally overriding only initial p7 for the narrow shrink fixture. */
async function corpus(count: number, initialP7Body?: string): Promise<PageId[]> {
  const ids: PageId[] = [];
  for (let at = 0; at < count; at += 1) {
    const body = at === 7 && initialP7Body !== undefined ? initialP7Body
      : `Topic ${at} first paragraph ${"words ".repeat(30)}\n\nTopic ${at} second paragraph ${"more ".repeat(30)}`;
    await writePage(root, "concepts", `p${at}`, body);
    ids.push(`concepts/p${at}` as PageId);
  }
  await writePage(root, "queries", "p1", `Query namesake ${"text ".repeat(30)}`);
  ids.push("queries/p1" as PageId);
  await updateEmbeddings(root, ids);
  return ids;
}

/** The incumbent results before activation and the sharded results after, for the same corpus state. */
async function bothWays(mutate?: () => Promise<void>): Promise<{ before: unknown[]; after: unknown[] }> {
  const run = async () => {
    const { store } = await loadEmbeddingsForSearch(root);
    return [await findRelevantPagesV3(root, store!, "search", QUESTION, 5), await findRelevantChunksV3(root, store!, "search", QUESTION, 8)];
  };
  await mutate?.();
  const before = await run();
  await activateIndexed(root);
  return { before, after: await run() };
}

describe("parity with the whole-store pipeline", () => {
  it("returns the same pages, chunks, scores and stale reports, ties included", async () => {
    await corpus(30);
    const { before, after } = await bothWays();
    expect(after).toEqual(before);
  });

  it("does not let stale high scorers, more than any fixed overfetch, crowd out fresh lower ones", async () => {
    await corpus(40);
    const { store } = await loadEmbeddingsForSearch(root);
    const ranked = (await findRelevantPagesV3(root, store!, "search", QUESTION, 17)).hits.map((hit) => hit.pageId);
    const stale = ranked.slice(0, 12);
    const { before, after } = await bothWays(async () => {
      // A page-level embedding covers title and summary, so changing the summary makes the page stale.
      for (const pageId of stale) {
        const [dir, slug] = pageId.split("/") as [string, string];
        await writeFile(path.join(root, "wiki", dir, `${slug}.md`), `---\ntitle: ${slug}\nsummary: Changed after embedding\n---\n\nEdited.\n`);
      }
    });
    expect(after).toEqual(before);
    const pages = after[0] as { hits: Array<{ pageId: string }>; stalePageIds: string[] };
    expect(pages.hits).toHaveLength(5);
    expect(pages.hits.some((hit) => stale.includes(hit.pageId as PageId))).toBe(false);
    expect([...pages.stalePageIds].sort()).toEqual([...stale].sort());
  });
});

describe("narrow refresh", () => {
  it("re-embeds only the changed page and rewrites only its pieces, never reading the backup", async () => {
    await corpus(60, `${"first ".repeat(100)}\n\n${"second ".repeat(85)}`);
    await activateIndexed(root);
    const backup = await readFile(path.join(root, ".llmwiki", "embeddings.json"));
    const initial = await openVectorStore(root);
    const [before7, before8] = [await initial.get("m:concepts/p7"), await initial.get("m:concepts/p8")];
    expect(asPageMetaRow(before7).chunkHashes).toHaveLength(2);
    expect(await initial.get(chunkVectorKey("concepts/p7", 1))).toBeDefined();
    await writePage(root, "concepts", "p7", `Topic seven rewritten ${"fresh ".repeat(30)}`);
    embedded.texts = 0;
    const counters = newCounters();
    await observeIo(counters, () => updateEmbeddings(root, ["concepts/p7" as PageId]));
    expect(embedded.texts).toBeLessThanOrEqual(3);
    expect(counters.segmentsWritten).toBeLessThanOrEqual(2);
    expect(counters.segmentBytesWritten).toBeLessThan(20_000);
    const vectors = await openVectorStore(root);
    const [changed, untouched] = [await vectors.get("m:concepts/p7"), await vectors.get("m:concepts/p8")];
    expect(changed).not.toEqual(before7);
    expect(untouched).toEqual(before8);
    expect(asPageMetaRow(changed).chunkHashes).toHaveLength(1);
    expect(await vectors.get(chunkVectorKey("concepts/p7", 1))).toBeUndefined();
    expect(vectorMetaOf(vectors).chunks).toBe(vectorMetaOf(initial).chunks - 1);
    expect(await readFile(path.join(root, ".llmwiki", "embeddings.json"))).toEqual(backup);
    await writeFile(path.join(root, ".llmwiki", "embeddings.json"), "{ corrupt backup");
    expect((await loadEmbeddingsForSearch(root)).store).not.toBeNull();
  });
});

describe("a corrupt piece", () => {
  it("fails the scan closed and never falls back to the retained backup", async () => {
    await corpus(5);
    await activateIndexed(root);
    const vectors = await openVectorStore(root);
    const segment = path.join(root, ".llmwiki", "indexed", "vectors", vectors.manifest.runs[0]!.segments[0]!.name);
    const bytes = await readFile(segment);
    bytes[10] = bytes[10]! ^ 1;
    await rm(segment);
    await writeFile(segment, bytes);
    const { store } = await loadEmbeddingsForSearch(root);
    await expect(findRelevantPagesV3(root, store!, "search", QUESTION, 3)).rejects.toMatchObject({ code: "indexed_store_corrupt" });
  });
});
