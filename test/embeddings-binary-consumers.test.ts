/**
 * Binary-backed retrieval must retain live freshness, ranked fill and independent
 * search/context eligibility. Only query embedding transport is replaced; disk
 * selection, profile filtering, ranking and live-page rehydration remain real.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { writePage } from "./fixtures/write-page.js";
import * as transport from "../src/utils/embedding-provider.js";
import { writeEmbeddingStore, resolveEmbeddingFingerprint, resolveEmbeddingModel, type EmbeddingStoreV3 } from "../src/utils/embeddings-store.js";
import { loadEmbeddingsForSearch, loadEmbeddingsForContext, findRelevantPagesV3, findRelevantChunksV3 } from "../src/utils/embeddings-load.js";
import { buildEmbeddingText } from "../src/utils/embeddings-pages.js";
import { hashChunkText } from "../src/utils/retrieval.js";
import type { LoadedProfile } from "../src/profile/types.js";

const ctx = useConfinementRoots("binary-consumers");
beforeEach(() => {
  vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "true");
  vi.stubGlobal("fetch", () => { throw new Error("NETWORK FORBIDDEN in consumer witness"); });
  vi.spyOn(transport, "getEmbeddingProvider").mockReturnValue({
    embed: async () => [1, 0],
  } as unknown as ReturnType<typeof transport.getEmbeddingProvider>);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Build stored metadata from real live pages, with deliberately poisoned caches. */
async function storeFor(ids: string[]): Promise<EmbeddingStoreV3> {
  const entries = [];
  const chunks = [];
  for (const [index, pageId] of ids.entries()) {
    const [namespace, slug] = pageId.split("/");
    const dir = path.join(ctx.root, "wiki", namespace);
    await mkdir(dir, { recursive: true });
    await writePage(dir, slug, { title: slug, summary: "live summary" }, `Live ${slug} evidence.`);
    const vector = [1, index / 2];
    entries.push({ pageId, title: "cached", summary: "cached", vector, updatedAt: "t",
      embeddingTextHash: hashChunkText(buildEmbeddingText({ title: slug, summary: "live summary" })) });
    chunks.push({ pageId, title: "cached", vector, updatedAt: "t", chunkIndex: 0,
      contentHash: hashChunkText(`Live ${slug} evidence.`), text: "cached poison" });
  }
  return { version: 3, model: resolveEmbeddingModel(), fingerprint: resolveEmbeddingFingerprint(),
    dimensions: 2, entries, chunks };
}

it("fills past stale top-ranked binary pages and chunks with fresh live results", async () => {
  const store = await storeFor(["concepts/stale", "concepts/near", "concepts/far"]);
  store.entries[0].embeddingTextHash = "stale";
  store.chunks![0].contentHash = "stale";
  await writeEmbeddingStore(ctx.root, store);
  const loaded = await loadEmbeddingsForSearch(ctx.root);
  expect(loaded.warnings).toEqual([]);
  const pages = await findRelevantPagesV3(ctx.root, loaded.store!, "search", "question", 2);
  const chunks = await findRelevantChunksV3(ctx.root, loaded.store!, "search", "question", 2);
  expect(pages.hits.map(hit => hit.pageId)).toEqual(["concepts/near", "concepts/far"]);
  expect(chunks.hits.map(hit => hit.pageId)).toEqual(["concepts/near", "concepts/far"]);
  expect(pages.stalePageIds).toEqual(["concepts/stale"]);
  expect(chunks.stalePageIds).toEqual(["concepts/stale"]);
  expect(pages.hits[0]).toMatchObject({ title: "near", summary: "live summary" });
  expect(chunks.hits[0].text).toBe("Live near evidence.");
  expect(pages.hits[0].score).toBeGreaterThan(pages.hits[1].score);
});

it("keeps a binary typed page eligible for context but excluded from search", async () => {
  await writeEmbeddingStore(ctx.root, await storeFor(["notes/context-only"]));
  const profile = { profile: { schemaVersion: 1, profileId: "fixture", entities: {
    notes: { directory: "wiki/notes", retrieval: { includeInSearch: false, includeInContext: true } },
  } }, loadedFrom: null, digest: "" } as LoadedProfile;
  const search = await loadEmbeddingsForSearch(ctx.root);
  const context = await loadEmbeddingsForContext(ctx.root);
  expect((await findRelevantPagesV3(ctx.root, search.store!, "search", "question", 2, profile)).hits).toEqual([]);
  const result = await findRelevantPagesV3(ctx.root, context.store!, "context", "question", 2, profile);
  expect(result.hits.map(hit => hit.pageId)).toEqual(["notes/context-only"]);
  expect(result.hits[0].title).toBe("context-only");
});
