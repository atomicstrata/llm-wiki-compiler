/**
 * @file test/embeddings-caps.test.ts
 * @description Per-field cap and integrity-policy tests for the embedding store.
 *
 * Covers: over-long slug/title/summary/text fields are rejected on write;
 * a non-finite or wrong-length vector makes the WHOLE store unavailable (not a
 * single-record drop — this is a store integrity failure); a normal v2 store
 * ranks identically after confinement hardening (parity).
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readEmbeddingStore, writeEmbeddingStore, type EmbeddingStore, type EmbeddingEntry, type ChunkEmbeddingEntry } from "../src/utils/embeddings-store.js";
import { EMBEDDINGS_FILE, LLMWIKI_DIR, MAX_EMBEDDING_FIELD_CHARS } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { findTopK } from "../src/utils/embeddings.js";

const ctx = useConfinementRoots("embed-caps");

function pageEntry(overrides: Partial<EmbeddingEntry> = {}): EmbeddingEntry {
  return { slug: "pg", title: "Title", summary: "Summary", vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

function chunkEntry(overrides: Partial<ChunkEmbeddingEntry> = {}): ChunkEmbeddingEntry {
  return { slug: "pg", title: "Title", chunkIndex: 0, contentHash: "h", text: "body", vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

function storeWith(entry: EmbeddingEntry): EmbeddingStore {
  return { version: 2, model: "m", dimensions: 2, entries: [entry], chunks: [] };
}

describe("per-field cap enforcement on write", () => {
  it("rejects an entry with an over-long slug", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    const entry = pageEntry({ slug: "x".repeat(MAX_EMBEDDING_FIELD_CHARS + 1) });
    await expect(writeEmbeddingStore(ctx.root, storeWith(entry))).rejects.toThrow();
  });

  it("rejects an entry with an over-long title", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    const entry = pageEntry({ title: "x".repeat(MAX_EMBEDDING_FIELD_CHARS + 1) });
    await expect(writeEmbeddingStore(ctx.root, storeWith(entry))).rejects.toThrow();
  });

  it("rejects an entry with an over-long summary", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    const entry = pageEntry({ summary: "x".repeat(MAX_EMBEDDING_FIELD_CHARS + 1) });
    await expect(writeEmbeddingStore(ctx.root, storeWith(entry))).rejects.toThrow();
  });

  it("rejects a chunk with an over-long text field", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    const chunk = chunkEntry({ text: "x".repeat(MAX_EMBEDDING_FIELD_CHARS + 1) });
    const store: EmbeddingStore = { version: 2, model: "m", dimensions: 2, entries: [], chunks: [chunk] };
    await expect(writeEmbeddingStore(ctx.root, store)).rejects.toThrow();
  });
});

/** Write a corrupt store directly (bypassing writeEmbeddingStore validation) and read it back. */
async function readCorruptStore(root: string, store: EmbeddingStore): Promise<EmbeddingStore | null> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(path.join(root, EMBEDDINGS_FILE), JSON.stringify(store), "utf8");
  return readEmbeddingStore(root);
}

describe("integrity policy: non-finite or wrong-length vector → whole store unavailable", () => {
  it("returns null when a page entry has a non-finite vector (NaN)", async () => {
    const store: EmbeddingStore = { version: 2, model: "m", dimensions: 2, entries: [pageEntry({ vector: [NaN, 0] })], chunks: [] };
    expect(await readCorruptStore(ctx.root, store)).toBeNull();
  });

  it("returns null when a page entry vector has wrong length", async () => {
    const store: EmbeddingStore = { version: 2, model: "m", dimensions: 2, entries: [pageEntry({ vector: [1, 0, 0] })], chunks: [] };
    expect(await readCorruptStore(ctx.root, store)).toBeNull();
  });
});

describe("ranking parity after confinement hardening", () => {
  it("findTopK ranks a normal v2 store identically to before", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    const store: EmbeddingStore = {
      version: 2, model: "m", dimensions: 2,
      entries: [pageEntry({ slug: "a", vector: [1, 0] }), pageEntry({ slug: "b", vector: [0, 1] })],
      chunks: [],
    };
    await writeEmbeddingStore(ctx.root, store);
    const loaded = await readEmbeddingStore(ctx.root);
    expect(loaded).not.toBeNull();
    const top = findTopK([1, 0], loaded!, 2);
    expect(top[0].slug).toBe("a");
    expect(top[1].slug).toBe("b");
  });
});
