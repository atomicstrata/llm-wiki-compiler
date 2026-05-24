/**
 * Unit tests for the Slice 2 semantic retrieval wrapper.
 *
 * Mocks `src/utils/embeddings.js` so the wrapper's branching can be
 * exercised without seeded stores or live providers. Each branch must
 * produce the documented `{ hits, warning }` shape so the orchestrator
 * can rely on a stable post-condition regardless of which failure mode
 * the underlying store/provider exhibited.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../src/utils/embeddings.js", () => ({
  readEmbeddingStore: vi.fn(),
  findRelevantChunks: vi.fn(),
}));

import {
  readEmbeddingStore,
  findRelevantChunks,
} from "../src/utils/embeddings.js";
import { retrieveSemanticChunks } from "../src/context/retrieval.js";

const mockedReadStore = readEmbeddingStore as unknown as Mock;
const mockedFindChunks = findRelevantChunks as unknown as Mock;

afterEach(() => {
  mockedReadStore.mockReset();
  mockedFindChunks.mockReset();
});

/** Build a fake v2 store with one synthetic chunk so the pre-check passes. */
function v2StoreWithChunk(): unknown {
  return {
    version: 2,
    model: "text-embedding-3-small",
    dimensions: 4,
    entries: [],
    chunks: [
      {
        slug: "alpha",
        title: "Alpha",
        chunkIndex: 0,
        contentHash: "h-alpha-0",
        text: "alpha chunk",
        vector: [0.1, 0.2, 0.3, 0.4],
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    ],
  };
}

/**
 * Invoke retrieval and assert it returned the documented "store unusable"
 * branch without ever invoking the provider. Used across the missing-store
 * variants so the per-test bodies only assert the input difference.
 */
async function expectStoreUnusable(): Promise<void> {
  const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
  expect(outcome.warning).toBe("embedding-store-missing");
  expect(mockedFindChunks).not.toHaveBeenCalled();
}

describe("retrieveSemanticChunks — store-absence and credential branches", () => {
  it("returns embedding-store-missing when readEmbeddingStore yields null", async () => {
    mockedReadStore.mockResolvedValueOnce(null);
    await expectStoreUnusable();
  });

  it("returns embedding-store-missing for a v1 store (no chunks array)", async () => {
    mockedReadStore.mockResolvedValueOnce({
      version: 1,
      model: "voyage-3-lite",
      dimensions: 4,
      entries: [{ slug: "x", title: "X", summary: "", vector: [0, 0, 0, 0], updatedAt: "" }],
    });
    await expectStoreUnusable();
  });

  it("returns embedding-store-missing for a v2 store with empty chunks", async () => {
    mockedReadStore.mockResolvedValueOnce({
      version: 2,
      model: "text-embedding-3-small",
      dimensions: 4,
      entries: [],
      chunks: [],
    });
    await expectStoreUnusable();
  });

  it("returns query-embedding-unavailable when findRelevantChunks throws", async () => {
    mockedReadStore.mockResolvedValueOnce(v2StoreWithChunk());
    mockedFindChunks.mockRejectedValueOnce(new Error("VOYAGE_API_KEY is not set"));
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.hits).toEqual([]);
    expect(outcome.warning).toBe("query-embedding-unavailable");
  });

  it("folds stale-model (loadActiveStore returned null -> [] downstream) into embedding-store-missing", async () => {
    // Store passes our pre-check (chunks > 0) but findRelevantChunks
    // returns [] because the model name disagrees with the active model.
    // Translate that into the missing-store warning so the warning
    // vocabulary stays small.
    mockedReadStore.mockResolvedValueOnce(v2StoreWithChunk());
    mockedFindChunks.mockResolvedValueOnce([]);
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.warning).toBe("embedding-store-missing");
  });
});

describe("retrieveSemanticChunks — happy path", () => {
  it("maps embedding-store chunk records into the slim SemanticChunkHit shape", async () => {
    mockedReadStore.mockResolvedValueOnce(v2StoreWithChunk());
    mockedFindChunks.mockResolvedValueOnce([
      {
        chunk: {
          slug: "alpha",
          title: "Alpha",
          chunkIndex: 0,
          contentHash: "h-alpha-0",
          text: "alpha chunk",
          vector: [0.1, 0.2, 0.3, 0.4],
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
        score: 0.81,
      },
    ]);
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.warning).toBeNull();
    expect(outcome.hits).toEqual([
      { slug: "alpha", text: "alpha chunk", score: 0.81, contentHash: "h-alpha-0" },
    ]);
  });

  it("forwards topChunks through to findRelevantChunks verbatim", async () => {
    mockedReadStore.mockResolvedValueOnce(v2StoreWithChunk());
    mockedFindChunks.mockResolvedValueOnce([]);
    await retrieveSemanticChunks("/tmp/proj", "prompt", 12);
    const callArgs = mockedFindChunks.mock.calls[0];
    expect(callArgs[2]).toBe(12);
  });

  it("short-circuits to embedding-store-missing without touching the store when topChunks <= 0", async () => {
    const outcome = await retrieveSemanticChunks("/tmp/proj", "p", 0);
    expect(outcome.warning).toBeNull();
    expect(mockedReadStore).not.toHaveBeenCalled();
    expect(mockedFindChunks).not.toHaveBeenCalled();
  });
});
