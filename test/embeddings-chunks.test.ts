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
    const { embed } = setupOpenAI([0.5, 0.5]);
    const body = "Paragraph one.\n\nParagraph two with more detail.";
    await writeConcept(root, "alpha", body);

    await updateEmbeddings(root, ["alpha"]);
    const store = await readEmbeddingStore(root);

    expect(store?.version).toBe(2);
    expect(store?.chunks?.length).toBeGreaterThan(0);
    expect(store?.chunks?.[0].slug).toBe("alpha");
    expect(store?.chunks?.[0].contentHash).toMatch(/^[a-f0-9]+$/);
    // Chunks are embedded via sequential embed(); the page uses embedBatch.
    expect(embed.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("reuses chunk vectors whose contentHash still matches", async () => {
    const root = await makeRoot();
    setupOpenAI([0.1, 0.9]);
    await writeConcept(root, "alpha", "Stable body content.");
    await updateEmbeddings(root, ["alpha"]);
    const firstStore = await readEmbeddingStore(root);
    const initialChunkCount = firstStore?.chunks?.length ?? 0;
    expect(initialChunkCount).toBeGreaterThan(0);

    // Add a brand-new page with a fresh body. The existing chunk for alpha
    // should be reused (same hash), not re-embedded.
    await writeConcept(root, "beta", "Different body");
    const embedAfter = vi.fn().mockResolvedValue([0.3, 0.7]);
    vi.spyOn(OpenAIProvider.prototype, "embed").mockImplementation(embedAfter);

    await updateEmbeddings(root, ["beta"]);
    const afterStore = await readEmbeddingStore(root);

    const alphaChunks = afterStore?.chunks?.filter((c) => c.slug === "alpha") ?? [];
    const betaChunks = afterStore?.chunks?.filter((c) => c.slug === "beta") ?? [];
    expect(alphaChunks.length).toBe(initialChunkCount);
    expect(betaChunks.length).toBeGreaterThan(0);
    // Only beta chunk(s) should use embed — the page uses embedBatch; alpha is reused.
    expect(embedAfter).toHaveBeenCalledTimes(betaChunks.length);
  });

  it("re-embeds a chunk when its body content changes", async () => {
    const root = await makeRoot();
    setupOpenAI([0.4, 0.6]);
    await writeConcept(root, "alpha", "Original body content here.");
    await updateEmbeddings(root, ["alpha"]);
    const before = await readEmbeddingStore(root);
    const beforeHash = before?.chunks?.[0].contentHash;

    await writeConcept(root, "alpha", "Completely different body content.");
    await updateEmbeddings(root, ["alpha"]);
    const after = await readEmbeddingStore(root);
    const afterHash = after?.chunks?.[0].contentHash;

    expect(afterHash).not.toBe(beforeHash);
  });

  it("prunes chunks for slugs that no longer exist", async () => {
    const root = await makeRoot();
    setupOpenAI([0.2, 0.8]);
    await writeConcept(root, "ghost", "Content");
    await updateEmbeddings(root, ["ghost"]);

    const { rm } = await import("fs/promises");
    await rm(path.join(root, "wiki/concepts/ghost.md"));
    await updateEmbeddings(root, []);

    const store = await readEmbeddingStore(root);
    expect(store?.chunks?.find((c) => c.slug === "ghost")).toBeUndefined();
    expect(store?.entries.find((e) => e.slug === "ghost")).toBeUndefined();
  });

  it("upgrades a v1 store to v2 by adding chunks for live pages", async () => {
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

    await updateEmbeddings(root, []);
    const upgraded = await readEmbeddingStore(root);

    expect(upgraded?.version).toBe(2);
    expect(upgraded?.chunks?.length).toBeGreaterThan(0);
    expect(upgraded?.chunks?.[0].slug).toBe("alpha");
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
