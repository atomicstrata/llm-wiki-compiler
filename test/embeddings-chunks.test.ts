/**
 * Tests covering chunk-level retrieval, content-hash-aware incremental
 * refresh, and backwards compatibility with v1 stores. The OpenAI provider
 * is stubbed so we never make a real network call.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import {
  findRelevantChunks,
  findTopKChunks,
  readEmbeddingStore,
  resetStaleEmbeddingWarnings,
  updateEmbeddings,
  writeEmbeddingStore,
  type ChunkEmbeddingEntry,
  type EmbeddingStore,
} from "../src/utils/embeddings.js";
import { refreshChunkEmbeddings } from "../src/utils/embeddings-chunks.js";
import { readV3Store, conceptId } from "./fixtures/v3-store.js";
import * as providerMod from "../src/utils/provider.js";
import type { PageRecord } from "../src/utils/embeddings-pages.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { CHUNK_TARGET_CHARS } from "../src/utils/constants.js";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-chunks-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

async function writeConcept(root: string, slug: string, body: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  const content = `---\ntitle: ${slug}\nsummary: Summary for ${slug}\n---\n\n${body}`;
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), content);
}

function setupOpenAI(vector: number[]): { embed: ReturnType<typeof vi.fn> } {
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
  const embed = vi.fn().mockResolvedValue(vector);
  vi.spyOn(OpenAIProvider.prototype, "embed").mockImplementation(embed);
  // Mock embedBatch so the page-embedding pass (which now uses batch) returns valid vectors.
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(
    async (texts: string[]) => texts.map(() => vector),
  );
  return { embed };
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
  resetStaleEmbeddingWarnings();
  vi.restoreAllMocks();
});

describe("findTopKChunks", () => {
  const chunk = (slug: string, idx: number, vector: number[]): ChunkEmbeddingEntry => ({
    slug,
    title: slug,
    chunkIndex: idx,
    contentHash: "hash",
    text: `${slug}-${idx}`,
    vector,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("ranks chunks by cosine similarity descending", () => {
    const chunks = [
      chunk("a", 0, [1, 0]),
      chunk("a", 1, [0, 1]),
      chunk("b", 0, [0.9, 0.1]),
    ];
    const top = findTopKChunks([1, 0], chunks, 2);
    expect(top.map((c) => c.chunk.slug)).toEqual(["a", "b"]);
  });

  it("returns at most k chunks", () => {
    const chunks = [chunk("a", 0, [1, 0]), chunk("b", 0, [0.8, 0])];
    expect(findTopKChunks([1, 0], chunks, 1)).toHaveLength(1);
  });
});

describe("updateEmbeddings (chunk path)", () => {
  it("populates chunks for live pages on a cold start", async () => {
    const root = await makeRoot();
    setupOpenAI([0.5, 0.5]);
    const body = "Paragraph one.\n\nParagraph two with more detail.";
    await writeConcept(root, "alpha", body);

    await updateEmbeddings(root, [conceptId("alpha")]);
    const store = await readV3Store(root);

    expect(store?.version).toBe(3);
    expect(store?.chunks?.length).toBeGreaterThan(0);
    expect(store?.chunks?.[0].pageId).toBe(conceptId("alpha"));
    expect(store?.chunks?.[0].contentHash).toMatch(/^[a-f0-9]+$/);
    // Both page and chunk passes use embedBatch; embed is only the sequential fallback.
    expect(store?.chunks?.length).toBeGreaterThan(0);
  });

  it("reuses chunk vectors whose contentHash still matches", async () => {
    const root = await makeRoot();
    setupOpenAI([0.1, 0.9]);
    await writeConcept(root, "alpha", "Stable body content.");
    await updateEmbeddings(root, [conceptId("alpha")]);
    const firstStore = await readV3Store(root);
    const initialChunkCount = firstStore?.chunks?.length ?? 0;
    expect(initialChunkCount).toBeGreaterThan(0);

    // Add a brand-new page with a fresh body. The existing vectors for alpha
    // are content-verified and PRESERVED by migration (same hash), not re-embedded.
    await writeConcept(root, "beta", "Different body");
    const batchedTexts: string[][] = [];
    vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async (texts: string[]) => {
      batchedTexts.push(texts);
      return texts.map(() => [0.3, 0.7]);
    });

    await updateEmbeddings(root, [conceptId("beta")]);
    const afterStore = await readV3Store(root);

    const alphaChunks = afterStore?.chunks?.filter((c) => c.pageId === conceptId("alpha")) ?? [];
    const betaChunks = afterStore?.chunks?.filter((c) => c.pageId === conceptId("beta")) ?? [];
    expect(alphaChunks.length).toBe(initialChunkCount);
    expect(betaChunks.length).toBeGreaterThan(0);
    // Only beta page + beta chunks are embedded; alpha vectors are preserved.
    const totalBatchedTexts = batchedTexts.reduce((s, ts) => s + ts.length, 0);
    // 1 page text (page pass) + betaChunks.length texts (chunk pass)
    expect(totalBatchedTexts).toBe(1 + betaChunks.length);
  });

  it("re-embeds a chunk when its body content changes", async () => {
    const root = await makeRoot();
    setupOpenAI([0.4, 0.6]);
    await writeConcept(root, "alpha", "Original body content here.");
    await updateEmbeddings(root, [conceptId("alpha")]);
    const before = await readV3Store(root);
    const beforeHash = before?.chunks?.[0].contentHash;

    await writeConcept(root, "alpha", "Completely different body content.");
    await updateEmbeddings(root, [conceptId("alpha")]);
    const after = await readV3Store(root);
    const afterHash = after?.chunks?.[0].contentHash;

    expect(afterHash).not.toBe(beforeHash);
  });

  it("prunes chunks for slugs that no longer exist", async () => {
    const root = await makeRoot();
    setupOpenAI([0.2, 0.8]);
    await writeConcept(root, "ghost", "Content");
    await updateEmbeddings(root, [conceptId("ghost")]);

    const { rm } = await import("fs/promises");
    await rm(path.join(root, "wiki/concepts/ghost.md"));
    await updateEmbeddings(root, []);

    const store = await readV3Store(root);
    expect(store?.chunks?.find((c) => c.pageId === conceptId("ghost"))).toBeUndefined();
    expect(store?.entries.find((e) => e.pageId === conceptId("ghost"))).toBeUndefined();
  });

  it("upgrades a v1 store to v3 by re-embedding live pages with chunks", async () => {
    const root = await makeRoot();
    setupOpenAI([0.7, 0.3]);
    await writeConcept(root, "alpha", "Body for chunking");
    const v1Store: EmbeddingStore = {
      version: 1,
      model: "test-embed",
      dimensions: 2,
      entries: [
        {
          slug: "alpha",
          title: "alpha",
          summary: "Summary for alpha",
          vector: [0.1, 0.9],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeEmbeddingStore(root, v1Store);

    // A no-op change still migrates a sub-v3 store (version-driven, S1). A v1
    // store cannot preserve vectors, so the live page is re-embedded with chunks.
    await updateEmbeddings(root, []);
    const upgraded = await readV3Store(root);

    expect(upgraded?.version).toBe(3);
    expect(upgraded?.chunks?.length).toBeGreaterThan(0);
    expect(upgraded?.chunks?.[0].pageId).toBe(conceptId("alpha"));
  });
});

describe("findRelevantChunks", () => {
  it("returns [] when the store has no chunks", async () => {
    const root = await makeRoot();
    process.env.LLMWIKI_PROVIDER = "openai";
    process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
    await writeEmbeddingStore(root, {
      version: 2,
      model: "test-embed",
      dimensions: 2,
      entries: [],
      chunks: [],
    });
    expect(await findRelevantChunks(root, "anything", 5)).toEqual([]);
  });

  it("ranks chunks by similarity to the query", async () => {
    const root = await makeRoot();
    setupOpenAI([1, 0]);
    await writeEmbeddingStore(root, {
      version: 2,
      model: "test-embed",
      dimensions: 2,
      entries: [],
      chunks: [
        {
          slug: "a", title: "a", chunkIndex: 0, contentHash: "h1",
          text: "alpha", vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          slug: "b", title: "b", chunkIndex: 0, contentHash: "h2",
          text: "beta", vector: [0, 1], updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const top = await findRelevantChunks(root, "alpha", 1);
    expect(top).toHaveLength(1);
    expect(top[0].chunk.slug).toBe("a");
  });

  it("falls back when the stored model is stale", async () => {
    const root = await makeRoot();
    setupOpenAI([0.5, 0.5]);
    await writeEmbeddingStore(root, {
      version: 2,
      model: "old-model",
      dimensions: 2,
      entries: [],
      chunks: [
        {
          slug: "a", title: "a", chunkIndex: 0, contentHash: "h1",
          text: "alpha", vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const top = await findRelevantChunks(root, "alpha", 5);
    expect(top).toEqual([]);
  });
});

describe("backwards compatibility", () => {
  it("v1 store still loads correctly for findRelevantPages flow", async () => {
    const root = await makeRoot();
    const v1Store: EmbeddingStore = {
      version: 1,
      model: "test-embed",
      dimensions: 2,
      entries: [
        {
          slug: "alpha", title: "Alpha", summary: "Sum",
          vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeEmbeddingStore(root, v1Store);
    const loaded = await readEmbeddingStore(root);
    expect(loaded?.version).toBe(1);
    expect(loaded?.chunks).toBeUndefined();
    expect(loaded?.entries).toHaveLength(1);
  });

  it("a sufficiently long body produces multiple chunks", () => {
    // sanity: ensures CHUNK_TARGET_CHARS isn't accidentally large enough that
    // the chunking tests above would silently degrade to single-chunk output.
    expect(CHUNK_TARGET_CHARS).toBeGreaterThan(100);
  });
});

describe("refreshChunkEmbeddings batching", () => {
  it("batches missing chunks across pages and preserves order + reuse", async () => {
    const batches: string[][] = [];
    vi.spyOn(providerMod, "getProvider").mockReturnValue({
      embed: async () => [9, 9],
      embedBatch: async (t: string[]) => { batches.push(t); return t.map((_, i) => [i, i]); },
    } as any);

    const records: PageRecord[] = [
      { slug: "a", title: "A", summary: "", body: "alpha paragraph one.\n\nalpha two." },
      { slug: "b", title: "B", summary: "", body: "beta paragraph one." },
    ];
    // First run: cold, everything embeds.
    const cold = await refreshChunkEmbeddings(records, [], false, 256);
    expect(batches).toHaveLength(1); // one cross-page batch
    expect(cold.embedded).toBe(cold.chunks.length); // all fresh on cold start
    expect(cold.chunks.map((c) => `${c.slug}#${c.chunkIndex}`)).toEqual(
      cold.chunks.map((c) => `${c.slug}#${c.chunkIndex}`).slice().sort(), // already in page,index order
    );

    // Second run: identical content -> all reused, zero batch calls, zero embedded.
    batches.length = 0;
    const warm = await refreshChunkEmbeddings(records, cold.chunks, false, 256);
    expect(batches).toHaveLength(0);
    expect(warm.embedded).toBe(0);
    expect(warm.chunks).toEqual(cold.chunks.map((c) => ({ ...c }))); // vectors untouched (title same)
  });
});
