/**
 * @file test/scale/selection.test.ts
 * @description The persisted binary-container selection of `local-large`.
 *
 * Without a record, or on `local-standard`, the embedding writer behaves as
 * before (JSON unless the environment opts in). Once `local-large` is active,
 * even a project's FIRST store is written binary. An unreadable record makes
 * the write fail closed with nothing written. A writer binding without the new
 * optional fact keeps the incumbent selection exactly.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { restoreEnv, stubEnv } from "../stubs.js";
import { diskScaleTransitionSteps, setExpectedScale, setExpectedScaleWith } from "../../src/scale/transition.js";
import { diskStoredEmbeddingWrites, persistEmbeddingStore, persistEmbeddingStoreFrom } from "../../src/utils/embeddings-storage.js";
import { binaryFixture } from "../fixtures/binary-embedding-store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-select-"));
  stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "");
});
afterEach(async () => {
  restoreEnv();
  await rm(root, { recursive: true, force: true });
});

/** The embedding store leaves currently in the private directory. */
const storeFiles = async (): Promise<string[]> => (await readdir(path.join(root, ".llmwiki"))).filter((name) => name.startsWith("embeddings"));

/** Make `local-large` active on an empty project (no store to convert). */
async function activateLarge(): Promise<void> {
  const steps = { ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER } };
  expect((await setExpectedScaleWith(steps, { request: { documents: 2_000 } })).readiness).toBe("ready");
}

describe("which container an embedding write selects", () => {
  it("keeps JSON without a record and on local-standard, and honours the environment opt-in", async () => {
    await persistEmbeddingStore(root, binaryFixture());
    expect(await storeFiles()).toEqual(["embeddings.json"]);
    await setExpectedScale(root, { request: { documents: 100 } });
    await persistEmbeddingStore(root, binaryFixture());
    expect(await storeFiles()).toEqual(["embeddings.json"]);
    stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "1");
    await persistEmbeddingStore(root, binaryFixture());
    expect((await storeFiles()).sort()).toEqual(["embeddings.bin", "embeddings.json"]);
  });

  it("writes even the first store binary once local-large is active", async () => {
    await activateLarge();
    await persistEmbeddingStore(root, binaryFixture());
    expect(await storeFiles()).toEqual(["embeddings.bin"]);
  });

  it("keeps the incumbent selection for a writer binding without the optional fact", async () => {
    await activateLarge();
    const { binarySelected: _omitted, ...incumbent } = diskStoredEmbeddingWrites(root);
    await persistEmbeddingStoreFrom(incumbent, binaryFixture());
    expect(await storeFiles()).toEqual(["embeddings.json"]);
  });

  it("fails closed with nothing written when the record is unreadable", async () => {
    await mkdir(path.join(root, ".llmwiki"));
    await writeFile(path.join(root, ".llmwiki", "scale.json"), "{ not json");
    await expect(persistEmbeddingStore(root, binaryFixture())).rejects.toThrow("scale-state-unreadable");
    expect(await storeFiles()).toEqual([]);
  });
});
