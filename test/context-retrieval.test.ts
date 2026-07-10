/**
 * Unit tests for the v3 semantic retrieval wrapper.
 *
 * Mocks `src/utils/embeddings-load.js` so the wrapper's branching can be
 * exercised without seeded stores or live providers. Each branch must produce
 * the documented `{ hits, warning }` shape so the orchestrator can rely on a
 * stable post-condition regardless of which failure/degrade mode the underlying
 * v3 store/provider exhibited. `loadProfile` is mocked to the default profile.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { defaultProfileLoad } from "./fixtures/profile-fixtures.js";

vi.mock("../src/utils/embeddings-load.js", () => ({
  loadEmbeddingsForContext: vi.fn(),
  findRelevantChunksV3: vi.fn(),
}));
vi.mock("../src/profile/load.js", () => ({
  loadProfile: vi.fn(async () => defaultProfileLoad()),
}));

import { loadEmbeddingsForContext, findRelevantChunksV3 } from "../src/utils/embeddings-load.js";
import { retrieveSemanticChunks } from "../src/context/retrieval.js";

const mockedLoad = loadEmbeddingsForContext as unknown as Mock;
const mockedFindChunks = findRelevantChunksV3 as unknown as Mock;

afterEach(() => {
  mockedLoad.mockReset();
  mockedFindChunks.mockReset();
});

/** A degraded load outcome (store null) with the given warning code. */
function degraded(code: string): unknown {
  return { store: null, warnings: [{ code, message: "m" }], stalePageIds: [] };
}

/** A healthy v3 load outcome carrying a minimal usable store. */
function v3Outcome(): unknown {
  return { store: { version: 3, model: "m", dimensions: 4, entries: [], chunks: [] }, warnings: [], stalePageIds: [] };
}

describe("retrieveSemanticChunks — degrade and credential branches", () => {
  it("returns embedding-index-outdated when the load degrades (non-v3 store)", async () => {
    mockedLoad.mockResolvedValueOnce(degraded("embedding-index-outdated"));
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.warning).toBe("embedding-index-outdated");
    expect(mockedFindChunks).not.toHaveBeenCalled();
  });

  it("returns embedding-store-missing when the load reports no index", async () => {
    mockedLoad.mockResolvedValueOnce(degraded("embedding-store-missing"));
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.warning).toBe("embedding-store-missing");
    expect(mockedFindChunks).not.toHaveBeenCalled();
  });

  it("returns query-embedding-unavailable when the chunk pipeline throws an auth error", async () => {
    mockedLoad.mockResolvedValueOnce(v3Outcome());
    mockedFindChunks.mockRejectedValueOnce(new Error("VOYAGE_API_KEY is not set"));
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.hits).toEqual([]);
    expect(outcome.warning).toBe("query-embedding-unavailable");
  });

  it("returns semantic-retrieval-error for unexpected internal failures", async () => {
    mockedLoad.mockResolvedValueOnce(v3Outcome());
    mockedFindChunks.mockRejectedValueOnce(new Error("vector index invariant violated"));
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.hits).toEqual([]);
    expect(outcome.warning).toBe("semantic-retrieval-error");
  });

  it("emits embedding-store-missing when the v3 pipeline returns no hits", async () => {
    mockedLoad.mockResolvedValueOnce(v3Outcome());
    mockedFindChunks.mockResolvedValueOnce({ hits: [], stalePageIds: [] });
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.warning).toBe("embedding-store-missing");
  });
});

describe("retrieveSemanticChunks — happy path", () => {
  it("maps v3 chunk hits into the slim SemanticChunkHit shape (carrying pageId)", async () => {
    mockedLoad.mockResolvedValueOnce(v3Outcome());
    mockedFindChunks.mockResolvedValueOnce({
      hits: [{ pageId: "concepts/alpha", slug: "alpha", chunkIndex: 0, contentHash: "h-alpha-0", text: "alpha chunk", score: 0.81 }],
      stalePageIds: [],
    });
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.warning).toBeNull();
    expect(outcome.hits).toEqual([
      { pageId: "concepts/alpha", slug: "alpha", text: "alpha chunk", score: 0.81, contentHash: "h-alpha-0" },
    ]);
  });

  it("short-circuits without touching the store when topChunks <= 0", async () => {
    const outcome = await retrieveSemanticChunks("/tmp/proj", "p", 0);
    expect(outcome.warning).toBeNull();
    expect(mockedLoad).not.toHaveBeenCalled();
    expect(mockedFindChunks).not.toHaveBeenCalled();
  });
});

describe("retrieveSemanticChunks — embedding-entry-stale surfacing (context)", () => {
  const hit = { pageId: "concepts/alpha", slug: "alpha", chunkIndex: 0, contentHash: "h", text: "t", score: 0.8 };

  it("flags staleEntriesDetected when the chunk pipeline reports stale entries alongside hits", async () => {
    mockedLoad.mockResolvedValueOnce(v3Outcome());
    mockedFindChunks.mockResolvedValueOnce({ hits: [hit], stalePageIds: ["concepts/ghost"] });
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.warning).toBeNull();
    expect(outcome.staleEntriesDetected).toBe(true);
  });

  it("does NOT flag staleEntriesDetected for a clean v3 store (no stale entries)", async () => {
    mockedLoad.mockResolvedValueOnce(v3Outcome());
    mockedFindChunks.mockResolvedValueOnce({ hits: [hit], stalePageIds: [] });
    const outcome = await retrieveSemanticChunks("/tmp/proj", "any", 8);
    expect(outcome.staleEntriesDetected).toBe(false);
  });
});
