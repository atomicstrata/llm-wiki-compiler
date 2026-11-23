/**
 * @file test/vectors/import-identities.test.ts
 * @description Preserve the persisted source identity population during vector
 * migration. Malformed IDs accepted by the ordinary writer must refuse import
 * before any segment commit; a valid page/chunk pair imports without changing
 * its backup. These are offline real-disk fixtures, including reader leases;
 * they do not qualify native, crash, capacity or ordinary compiler generation.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { writeEmbeddingStore, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { importVectors } from "../../src/vectors/import.js";
import { openVectorStore, vectorMetaOf } from "../../src/vectors/store.js";
import { SegmentStore } from "../../src/segments/store.js";
import { expectVerifiedVectorBackup, useOfflineVectorFixture } from "./helpers.js";

const fixture = useOfflineVectorFixture("llmwiki-vec-int-");

/** Build a small writer-accepted source, optionally adding malformed identities beside valid rows. */
function importIdentityFixture(family: "entries" | "chunks" | "both" | null, pageId = ""): EmbeddingStoreV3 {
  const updatedAt = "2026-01-01T00:00:00.000Z";
  const page = { pageId: "concepts/keep", title: "Keep", summary: "Summary", embeddingTextHash: "a".repeat(64), vector: [1, 0], updatedAt };
  const chunk = { pageId: page.pageId, title: page.title, chunkIndex: 0, contentHash: "b".repeat(64), text: "Chunk", vector: [1, 0], updatedAt };
  return {
    version: 3, model: "offline-embed", dimensions: 2,
    entries: family === "entries" || family === "both" ? [page, { ...page, pageId }] : [page],
    chunks: family === "chunks" || family === "both" ? [chunk, { ...chunk, pageId }] : [chunk],
  };
}

describe("vector import source identities", () => {
  it.each([
    { name: "an unqualified page", family: "entries", pageId: "unqualified" },
    { name: "a dot-segment page", family: "entries", pageId: "concepts/.." },
    { name: "an unqualified chunk", family: "chunks", pageId: "unqualified" },
    { name: "mixed malformed pages and chunks", family: "both", pageId: "concepts/.." },
  ] as const)("refuses $name before any import commit", async ({ family, pageId }) => {
    const { root } = fixture;
    const source = importIdentityFixture(family, pageId);
    await writeEmbeddingStore(root, source);
    const backup = path.join(root, ".llmwiki", "embeddings.json");
    const bytes = await readFile(backup);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(source);
    const commit = vi.spyOn(SegmentStore.prototype, "commit");
    await expect(importVectors(root)).rejects.toThrow("malformed page IDs; repair the source store");
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(backup)).toEqual(bytes);
  });

  it("imports every valid page and chunk and leaves the backup unchanged", async () => {
    const { root } = fixture;
    await writeEmbeddingStore(root, importIdentityFixture(null));
    const backup = path.join(root, ".llmwiki", "embeddings.json");
    const bytes = await readFile(backup);
    await importVectors(root);
    expect(vectorMetaOf(await openVectorStore(root))).toMatchObject({ phase: "ready", pages: 1, chunks: 1, legacy: { records: 2 } });
    await expectVerifiedVectorBackup(root, bytes, 2);
  });
});
