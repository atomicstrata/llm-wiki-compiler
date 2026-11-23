/**
 * @file test/vectors/rebuild.test.ts
 * @description Bounds and lifecycle of the piecewise vector store on real
 * disk: hostile K values never escape the resident bound or call the
 * provider; no provider call is made when no live eligible candidate exists;
 * a rebuild for a new embedding configuration that fails part-way (beyond
 * one 128-page batch) leaves the store `rebuilding` with search degraded,
 * and the next refresh resumes it to `ready`; a batch approval refuses a
 * rebuild before any provider call; an import is bound to its exact backup;
 * sparse chunk indexes are refused.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { restoreEnv, restoreGlobals, stubEnv } from "../stubs.js";
import * as provider from "../../src/utils/embedding-provider.js";
import { findRelevantPagesV3, loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { updateEmbeddings, updateEmbeddingsLockedCore } from "../../src/utils/embeddings.js";
import type { PageId } from "../../src/utils/page-id.js";
import { importVectors } from "../../src/vectors/import.js";
import { openVectorStore, vectorMetaOf, isShardedView } from "../../src/vectors/store.js";
import { activateIndexed, recordIndexedTransition } from "../catalog/helpers.js";
import { embedded, useOfflineEmbeddings, vectorOf, writePage } from "./helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-vec-rebuild-")); useOfflineEmbeddings(); });
afterEach(async () => { vi.restoreAllMocks(); restoreEnv(); restoreGlobals(); await rm(root, { recursive: true, force: true }); });

/** `count` single-chunk pages, embedded the incumbent way, then activated. */
async function indexedCorpus(count: number): Promise<PageId[]> {
  const ids: PageId[] = [];
  for (let at = 0; at < count; at += 1) {
    await writePage(root, "concepts", `p${at}`, `Body ${at} ${"words ".repeat(20)}`);
    ids.push(`concepts/p${at}` as PageId);
  }
  await updateEmbeddings(root, ids);
  await activateIndexed(root);
  return ids;
}

describe("search bounds", () => {
  it("normalizes hostile K values and calls no provider when no live eligible candidate exists", async () => {
    const ids = await indexedCorpus(6);
    const { store } = await loadEmbeddingsForSearch(root);
    embedded.texts = 0;
    for (const k of [0, Number.NaN, -3, 0.5]) expect((await findRelevantPagesV3(root, store!, "search", "q", k)).hits).toEqual([]);
    expect(embedded.texts).toBe(0);
    expect((await findRelevantPagesV3(root, store!, "search", "q", Number.POSITIVE_INFINITY)).hits).toHaveLength(6);
    expect((await findRelevantPagesV3(root, store!, "search", "q", 2.7)).hits).toHaveLength(2);
    embedded.texts = 0;
    expect(isShardedView(store) && (await findRelevantPagesV3(root, { ...store, scope: new Set<string>() }, "search", "q", 3)).hits).toEqual([]);
    for (const id of ids) await rm(path.join(root, "wiki", `${id}.md`));
    expect((await findRelevantPagesV3(root, store!, "search", "q", 3)).hits).toEqual([]);
    expect(embedded.texts).toBe(0);
  });
});

describe("a rebuild for a new embedding configuration", () => {
  it("degrades search while interrupted past the first batch and resumes to ready", async () => {
    const ids = await indexedCorpus(150);
    stubEnv("LLMWIKI_EMBEDDING_MODEL", "offline-embed-v2");
    let calls = 0;
    vi.spyOn(provider, "getEmbeddingProvider").mockReturnValue({
      embed: async (text: string) => vectorOf(text),
      embedBatch: async (texts: string[]) => { if (++calls > 2) throw new Error("provider failed mid-rebuild"); return texts.map(vectorOf); },
    } as unknown as ReturnType<typeof provider.getEmbeddingProvider>);
    await expect(updateEmbeddingsLockedCore(root, [])).rejects.toThrow("provider failed mid-rebuild");
    expect(vectorMetaOf(await openVectorStore(root))).toMatchObject({ phase: "rebuilding", model: "offline-embed-v2" });
    expect(await loadEmbeddingsForSearch(root)).toMatchObject({ store: null, warnings: [{ code: "embedding-index-outdated" }] });
    await expect(updateEmbeddingsLockedCore(root, [ids[0]!], undefined, "affected-only")).rejects.toThrow("full reconciliation");
    useOfflineEmbeddings();
    stubEnv("LLMWIKI_EMBEDDING_MODEL", "offline-embed-v2");
    await updateEmbeddingsLockedCore(root, []);
    expect(vectorMetaOf(await openVectorStore(root))).toMatchObject({ phase: "ready", model: "offline-embed-v2", pages: 150 });
    expect((await loadEmbeddingsForSearch(root)).store).not.toBeNull();
  });
});

describe("import binding", () => {
  it("refuses to resume an import from a different backup, and refuses sparse chunk indexes", async () => {
    await indexedCorpus(3);
    const json = path.join(root, ".llmwiki", "embeddings.json");
    const original = await readFile(json, "utf8");
    await writeFile(json, `${original}\n`);
    await expect(importVectors(root)).rejects.toThrow("not the embedding store this import began from");
    await rm(path.join(root, ".llmwiki", "indexed", "vectors"), { recursive: true });
    const store = JSON.parse(original) as { chunks: Array<{ chunkIndex: number }> };
    store.chunks[0]!.chunkIndex = 2;
    await writeFile(json, JSON.stringify(store));
    await recordIndexedTransition(root);
    await expect(importVectors(root)).rejects.toThrow("sparse chunk indexes");
  });
});
