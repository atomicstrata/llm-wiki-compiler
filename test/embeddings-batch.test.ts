/**
 * Tests for the batched embedding pipeline (updateEmbeddingsBatched) and
 * store persistence. The OpenAI provider is stubbed so no real network
 * calls are made.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import {
  readEmbeddingStore,
  resetStaleEmbeddingWarnings,
  writeEmbeddingStore,
  type EmbeddingStore,
} from "../src/utils/embeddings.js";
import { updateEmbeddingsBatched } from "../src/utils/embeddings-batch.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { EMBEDDING_BATCH_SIZE } from "../src/utils/constants.js";
import {
  STORE_PATH,
  makeEntry,
  makeRoot,
  writeConceptPage,
  writeConcept,
} from "./helpers/embedding-store.js";

async function setupBatchTest(): Promise<{ root: string; embedBatch: ReturnType<typeof vi.fn> }> {
  const root = await makeRoot();
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
  delete process.env.LLMWIKI_BINARY_EMBEDDINGS;
  delete process.env.LLMWIKI_EMBEDDING_BATCH_SIZE;
  delete process.env.LLMWIKI_CHUNK_BATCH_SIZE;
  const embedBatch = vi.fn();
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(embedBatch);
  return { root, embedBatch };
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLMWIKI_BINARY_EMBEDDINGS;
  delete process.env.LLMWIKI_EMBEDDING_BATCH_SIZE;
  delete process.env.LLMWIKI_CHUNK_BATCH_SIZE;
  resetStaleEmbeddingWarnings();
  vi.restoreAllMocks();
});

describe("store persistence", () => {
  it("roundtrips a store as number[] vectors on disk", async () => {
    delete process.env.LLMWIKI_BINARY_EMBEDDINGS;
    const root = await makeRoot();
    const original: EmbeddingStore = {
      version: 2,
      model: "test-model",
      dimensions: 2,
      entries: [
        makeEntry("alpha", [0.1, 0.2]),
        makeEntry("beta", [0.4, 0.5]),
      ],
    };

    await writeEmbeddingStore(root, original);
    const loaded = await readEmbeddingStore(root);

    expect(loaded).not.toBeNull();
    expect(loaded!.model).toBe(original.model);
    expect(loaded!.entries).toHaveLength(2);
    expect(loaded!.entries[0].slug).toBe("alpha");
    expect(loaded!.entries[0].vector[0]).toBeCloseTo(0.1);
    expect(loaded!.entries[1].slug).toBe("beta");
    expect(loaded!.entries[1].vector[1]).toBeCloseTo(0.5);

    const { readFile } = await import("fs/promises");
    const raw = await readFile(path.join(root, STORE_PATH), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.version).toBe(2);
    expect(Array.isArray(onDisk.entries[0].vector)).toBe(true);
    expect(Array.isArray(onDisk.entries[1].vector)).toBe(true);
  });
});

describe("updateEmbeddingsBatched", () => {
  it("skips pages whose contentHash already matches the on-disk store", async () => {
    const { root, embedBatch } = await setupBatchTest();

    await writeConceptPage(root, "alpha");
    await writeConceptPage(root, "beta");

    embedBatch.mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => [0.1, 0.2]))
    );
    await updateEmbeddingsBatched(root, ["alpha", "beta"]);
    expect(embedBatch).toHaveBeenCalled();

    embedBatch.mockClear();
    await updateEmbeddingsBatched(root, ["alpha", "beta"]);
    expect(embedBatch).toHaveBeenCalledTimes(0);
  });

  it("batches page embeddings into groups of EMBEDDING_BATCH_SIZE", async () => {
    const { root, embedBatch } = await setupBatchTest();

    for (let i = 0; i < 25; i++) {
      await writeConceptPage(root, `page-${i}`);
    }
    const slugs = Array.from({ length: 25 }, (_, i) => `page-${i}`);

    embedBatch.mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => [0.1, 0.2]))
    );

    await updateEmbeddingsBatched(root, slugs);

    expect(embedBatch).toHaveBeenCalled();
    expect(embedBatch.mock.calls[0][0]).toHaveLength(EMBEDDING_BATCH_SIZE);
    expect(embedBatch.mock.calls[1][0]).toHaveLength(5);
  });

  it("batch-embeds chunks across a single page", async () => {
    const { root, embedBatch } = await setupBatchTest();

    let body = "";
    for (let i = 0; i < 50; i++) {
      body += `Paragraph ${i} with enough text to form chunks. `.repeat(20) + "\n\n";
    }
    await writeConcept(root, "big-page", body);

    embedBatch.mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => [0.5, 0.5]))
    );

    await updateEmbeddingsBatched(root, ["big-page"]);
    const store = await readEmbeddingStore(root);

    expect(embedBatch).toHaveBeenCalled();
    expect(store?.chunks?.length).toBeGreaterThan(0);
    for (const chunk of store?.chunks ?? []) {
      expect(chunk.contentHash).toMatch(/^[a-f0-9]{16}$/);
    }
  });
});
