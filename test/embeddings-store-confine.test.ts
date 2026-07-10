/**
 * @file test/embeddings-store-confine.test.ts
 * @description Confinement and resource-cap tests for the embedding store I/O.
 *
 * Covers: symlinked .llmwiki dir and embeddings.json leaf are rejected (fail
 * closed); a clean project (no .llmwiki) is not created by a read; an oversized
 * store file (fstat cap) is unavailable; a write that would exceed the cap throws
 * EmbeddingStoreFullError; and a normal v2 store reads back identically.
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { readEmbeddingStore, writeEmbeddingStore, EmbeddingStoreFullError, type EmbeddingStore } from "../src/utils/embeddings-store.js";
import { EMBEDDINGS_FILE, LLMWIKI_DIR, MAX_EMBEDDING_STORE_BYTES } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("embed-confine");

function validStore(): EmbeddingStore {
  return { version: 2, model: "m", dimensions: 2, entries: [{ slug: "a", title: "A", summary: "s", vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z" }], chunks: [] };
}

describe("embedding store dir-symlink confinement", () => {
  it("fails closed when .llmwiki is a symlink escaping the root", async () => {
    let created = true;
    try { await symlink(ctx.outside, path.join(ctx.root, LLMWIKI_DIR), "dir"); } catch { created = false; }
    if (!created) return; // skip: platform cannot create symlinks
    await expect(readEmbeddingStore(ctx.root)).rejects.toThrow();
  });
});

describe("embedding store leaf-symlink confinement", () => {
  it("returns null (unavailable) when embeddings.json is a symlink — does not read through", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    const outside = path.join(ctx.outside, "embeddings.json");
    await writeFile(outside, JSON.stringify(validStore()), "utf8");
    let created = true;
    try { await symlink(outside, path.join(ctx.root, EMBEDDINGS_FILE)); } catch { created = false; }
    if (!created) return; // skip: platform cannot create symlinks
    // A symlinked leaf must fail closed: return null (unavailable), never read through.
    const result = await readEmbeddingStore(ctx.root);
    expect(result).toBeNull();
  });
});

describe("embedding store clean-project no-mkdir contract", () => {
  it("returns null without creating .llmwiki on a clean project", async () => {
    const result = await readEmbeddingStore(ctx.root);
    expect(result).toBeNull();
    expect(existsSync(path.join(ctx.root, LLMWIKI_DIR))).toBe(false);
  });
});

describe("embedding store fstat size cap", () => {
  it("returns null (unavailable) when embeddings.json exceeds MAX_EMBEDDING_STORE_BYTES", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    // Write exactly one byte over the cap; fstat check must reject before parsing.
    const oversized = "x".repeat(MAX_EMBEDDING_STORE_BYTES + 1);
    await writeFile(path.join(ctx.root, EMBEDDINGS_FILE), oversized, "utf8");
    const result = await readEmbeddingStore(ctx.root);
    expect(result).toBeNull();
  });
});

describe("embedding store write size cap", () => {
  it("throws EmbeddingStoreFullError when the serialized store would exceed the cap", async () => {
    // Build many entries within per-field caps whose combined JSON exceeds the store cap.
    // Each entry's summary is at MAX_EMBEDDING_FIELD_CHARS; ~650 entries ≈ 65+ MiB total.
    const { MAX_EMBEDDING_FIELD_CHARS: FIELD_CAP } = await import("../src/utils/constants.js");
    const entryCount = Math.ceil(MAX_EMBEDDING_STORE_BYTES / FIELD_CAP) + 10;
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      slug: `p${i}`, title: "T", summary: "x".repeat(FIELD_CAP),
      vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const big: EmbeddingStore = { version: 2, model: "m", dimensions: 2, entries, chunks: [] };
    await expect(writeEmbeddingStore(ctx.root, big)).rejects.toBeInstanceOf(EmbeddingStoreFullError);
    expect(existsSync(path.join(ctx.root, EMBEDDINGS_FILE))).toBe(false);
  }, 30_000);
});

describe("embedding store parity (normal v2 store)", () => {
  it("round-trips a normal v2 store byte-identically", async () => {
    await mkdir(path.join(ctx.root, LLMWIKI_DIR));
    const store = validStore();
    await writeEmbeddingStore(ctx.root, store);
    const loaded = await readEmbeddingStore(ctx.root);
    expect(loaded).toEqual(store);
  });
});
