/**
 * Regression tests for embedding-store and read-side vector integrity.
 * These cases protect against silent zero-score ranking and warm-store
 * corruption surviving across compiles.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import {
  findRelevantPages,
  readEmbeddingStore,
  updateEmbeddings,
  writeEmbeddingStore,
  type EmbeddingStore,
} from "../src/utils/embeddings.js";
import { EmbeddingIntegrityError } from "../src/utils/embeddings-batch.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import * as providerMod from "../src/utils/provider.js";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-embed-validation-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

async function writeConcept(root: string, slug: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), `---\ntitle: ${slug}\nsummary: Sum\n---\n\nBody`);
}

async function writeRawStore(root: string, store: EmbeddingStore): Promise<void> {
  await writeFile(path.join(root, ".llmwiki/embeddings.json"), JSON.stringify(store, null, 2));
}

function pageStore(vector: number[], dimensions = 2): EmbeddingStore {
  return {
    version: 2,
    model: "test-embed",
    dimensions,
    entries: [{ slug: "alpha", title: "Alpha", summary: "Sum", vector, updatedAt: "2026-01-01T00:00:00.000Z" }],
    chunks: [],
  };
}

function setOpenAIEnv(): void {
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
}

function stubEmbeddingVectors(vector: number[]): void {
  vi.spyOn(OpenAIProvider.prototype, "embed").mockResolvedValue(vector);
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async (texts: string[]) => (
    texts.map(() => vector)
  ));
}

function setupOpenAI(vector: number[]): void {
  setOpenAIEnv();
  stubEmbeddingVectors(vector);
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
});

describe("read-side embedding validation", () => {
  it("rejects a query vector whose dimension does not match the active store", async () => {
    const root = await makeRoot();
    setupOpenAI([1, 0, 0]);
    await writeEmbeddingStore(root, pageStore([1, 0]));

    await expect(findRelevantPages(root, "alpha")).rejects.toBeInstanceOf(EmbeddingIntegrityError);
  });

  it("treats a corrupted active store as unusable instead of ranking poisoned vectors", async () => {
    const root = await makeRoot();
    setupOpenAI([1, 0]);
    await writeRawStore(root, pageStore([]));

    await expect(findRelevantPages(root, "alpha")).resolves.toEqual([]);
  });

  it("passes query input type through the provider embed seam", async () => {
    const root = await makeRoot();
    let seenInputType: string | undefined;
    process.env.LLMWIKI_PROVIDER = "openai";
    process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
    vi.spyOn(providerMod, "getProvider").mockReturnValue({
      complete: async () => "",
      stream: async () => "",
      toolCall: async () => "",
      embed: async (_text: string, inputType?: "document" | "query") => {
        seenInputType = inputType;
        return [1, 0];
      },
    });
    await writeEmbeddingStore(root, pageStore([1, 0]));

    await findRelevantPages(root, "alpha");

    expect(seenInputType).toBe("query");
  });
});

describe("updateEmbeddings corrupted-store recovery", () => {
  it("rebuilds an invalid same-model store instead of carrying bad vectors forward", async () => {
    const root = await makeRoot();
    setupOpenAI([0.9, 0.1]);
    await writeConcept(root, "alpha");
    await writeRawStore(root, pageStore([]));

    await updateEmbeddings(root, []);
    const rebuilt = await readEmbeddingStore(root);

    expect(rebuilt?.entries[0].vector).toEqual([0.9, 0.1]);
    expect(rebuilt?.dimensions).toBe(2);
  });
});
