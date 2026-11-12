/**
 * @file test/embeddings-empty-store.test.ts
 * @description An empty store must be inert, not poisonous (issue #154).
 *
 * A rebuild writes `dimensions: 0` — correct, because a rebuild discards every
 * old vector and the previous dimension describes nothing that survives it. But
 * when that rebuild also has nothing eligible to embed, the zero is what gets
 * persisted, and the read path then asserted every query vector against it:
 * `assertVectorValid(vec, 0)` fails for any real embedding, so EVERY query threw.
 * Permanently — no later compile rewrites the store, so it never recovered.
 *
 * Two independent guards are pinned here: a non-positive stored dimension is
 * treated as UNKNOWN rather than as the literal expected length, and a read with
 * no eligible candidates returns before embedding the query at all (which also
 * spares a billed provider round-trip that could only be scored against an empty
 * pool).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import * as providerMod from "../src/utils/provider.js";
import { resolveEmbeddingModel } from "../src/utils/embeddings-store.js";
import { loadEmbeddingsForSearch, findRelevantPagesV3, findRelevantChunksV3 } from "../src/utils/embeddings-load.js";

let root: string;
let embedCalls: number;

beforeEach(async () => {
  root = await makeTempRoot("empty-store");
  embedCalls = 0;
  vi.spyOn(providerMod, "getProvider").mockReturnValue({
    embed: async () => {
      embedCalls += 1;
      return [0.1, 0.2, 0.3];
    },
  } as never);
});

afterEach(() => vi.restoreAllMocks());

/** Persist a v3 store with no vectors and the dimension a rebuild leaves behind. */
async function writeEmptyStore(dimensions: number): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  const store = { version: 3, model: resolveEmbeddingModel(), dimensions, entries: [], chunks: [] };
  await writeFile(path.join(root, ".llmwiki/embeddings.json"), JSON.stringify(store, null, 2));
}

describe("a store with dimensions: 0 and no vectors", () => {
  it("loads instead of failing integrity validation", async () => {
    await writeEmptyStore(0);
    const outcome = await loadEmbeddingsForSearch(root);
    expect(outcome.store).not.toBeNull();
    expect(outcome.store?.dimensions).toBe(0);
  });

  it("returns no page hits rather than throwing on the query vector", async () => {
    await writeEmptyStore(0);
    const { store } = await loadEmbeddingsForSearch(root);
    const result = await findRelevantPagesV3(root, store!, "search", "anything", 5);
    expect(result.hits).toEqual([]);
  });

  it("returns no chunk hits rather than throwing on the query vector", async () => {
    await writeEmptyStore(0);
    const { store } = await loadEmbeddingsForSearch(root);
    const result = await findRelevantChunksV3(root, store!, "search", "anything", 5);
    expect(result.hits).toEqual([]);
  });

  it("never calls the embedding provider when there is nothing to rank", async () => {
    await writeEmptyStore(0);
    const { store } = await loadEmbeddingsForSearch(root);
    await findRelevantPagesV3(root, store!, "search", "anything", 5);
    await findRelevantChunksV3(root, store!, "search", "anything", 5);
    expect(embedCalls).toBe(0);
  });

  it("behaves the same when a prune left a nonzero dimension behind", async () => {
    await writeEmptyStore(768);
    const { store } = await loadEmbeddingsForSearch(root);
    const result = await findRelevantPagesV3(root, store!, "search", "anything", 5);
    expect(result.hits).toEqual([]);
    expect(embedCalls).toBe(0);
  });
});
