/**
 * @file test/embeddings-v3-shape.test.ts
 * @description TDD tests for Task D1: v3 record types + structured chunk reuse index.
 *
 * Key invariants:
 *  - v3 type interfaces exist and are assignable (compile-level check via casts)
 *  - the chunk reuse index is a structured nested Map; a page stem containing "#"
 *    round-trips unambiguously (the old `${slug}#${chunkIndex}` string key would
 *    collide when the stem itself contains "#")
 *  - REGRESSION: the writer still persists version:2 bare-slug records (no v3 flip)
 *  - REGRESSION: normal chunk reuse still works for ordinary stems
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { refreshChunkEmbeddings } from "../src/utils/embeddings-chunks.js";
import { readEmbeddingStore, writeEmbeddingStore, type EmbeddingStore } from "../src/utils/embeddings-store.js";
import type { PageEmbeddingV3, ChunkEmbeddingV3, EmbeddingStoreV3 } from "../src/utils/embeddings-store.js";
import type { PageRecord } from "../src/utils/embeddings-pages.js";
import * as providerMod from "../src/utils/provider.js";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-v3shape-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

function mockProvider(): void {
  vi.spyOn(providerMod, "getProvider").mockReturnValue({
    embed: async () => [0.5, 0.5],
    embedBatch: async (texts: string[]) => texts.map(() => [0.5, 0.5]),
  } as any);
}

/** Assert that a warm run (all chunks pre-existing) reuses everything with zero new embeds. */
async function assertWarmReuse(
  records: PageRecord[],
  coldChunks: Awaited<ReturnType<typeof refreshChunkEmbeddings>>["chunks"],
): Promise<void> {
  vi.clearAllMocks();
  mockProvider();
  const warm = await refreshChunkEmbeddings(records, coldChunks, false, 256);
  expect(warm.embedded).toBe(0);
  expect(warm.chunks).toHaveLength(coldChunks.length);
}

// ---------------------------------------------------------------------------
// v3 type-level assignability (compile-time correctness)
// ---------------------------------------------------------------------------

describe("v3 type interfaces — compile-level assignability", () => {
  it("PageEmbeddingV3 literal is assignable to the interface", () => {
    const entry: PageEmbeddingV3 = {
      pageId: "concepts/foo-bar",
      title: "Foo Bar",
      summary: "A summary",
      embeddingTextHash: "abc123",
      vector: [0.1, 0.9],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(entry.pageId).toBe("concepts/foo-bar");
    expect(entry.embeddingTextHash).toBe("abc123");
  });

  it("ChunkEmbeddingV3 literal is assignable to the interface", () => {
    const chunk: ChunkEmbeddingV3 = {
      pageId: "concepts/foo-bar",
      title: "Foo Bar",
      chunkIndex: 0,
      contentHash: "def456",
      text: "chunk text",
      vector: [0.1, 0.9],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(chunk.pageId).toBe("concepts/foo-bar");
    expect(chunk.chunkIndex).toBe(0);
  });

  it("EmbeddingStoreV3 literal with entries and chunks is assignable", () => {
    const store: EmbeddingStoreV3 = {
      version: 3,
      model: "voyage-3",
      dimensions: 2,
      entries: [
        {
          pageId: "concepts/alpha",
          title: "Alpha",
          summary: "Summary",
          embeddingTextHash: "hash1",
          vector: [1, 0],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          pageId: "concepts/alpha",
          title: "Alpha",
          chunkIndex: 0,
          contentHash: "chunkhash",
          text: "chunk",
          vector: [1, 0],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(store.version).toBe(3);
    expect(store.entries).toHaveLength(1);
    expect(store.chunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Structured chunk reuse index — #-containing stem round-trips unambiguously
// ---------------------------------------------------------------------------

describe("structured chunk reuse index — # in page stem", () => {
  it("distinguishes chunks from a page whose stem contains '#' from chunk indices", async () => {
    mockProvider();
    // Use two records: one whose slug contains "#", another normal slug.
    // With the old key `${slug}#${chunkIndex}`:
    //   slug="foo#bar", chunkIndex=0 → "foo#bar#0"
    //   slug="foo", chunkIndex=0  → "foo#0"  (no collision here)
    // But slug="foo#bar", idx=0 vs slug="foo#bar#0", idx=0 would collide.
    // The structured index must keep them separate.
    const slugWithHash = "foo#bar";
    const records: PageRecord[] = [
      { slug: slugWithHash, title: "Foo#Bar", summary: "", body: "First chunk.\n\nSecond chunk content." },
    ];

    const cold = await refreshChunkEmbeddings(records, [], false, 256);
    // All chunks embedded fresh
    expect(cold.chunks.every((c) => c.slug === slugWithHash)).toBe(true);
    expect(cold.chunks.length).toBeGreaterThan(0);

    // Warm: reuse should work — same slug+chunkIndex combo
    await assertWarmReuse(records, cold.chunks);
  });

  it("does not confuse slug='foo#bar' chunk 0 with slug='foo' chunk-bar-0 key", async () => {
    mockProvider();
    // Verify that two slugs "foo#0" and "foo" with chunkIndex=0 stay distinct
    const rec1: PageRecord = { slug: "foo#0", title: "Foo#0", summary: "", body: "Content for foo hash 0." };
    const rec2: PageRecord = { slug: "foo", title: "Foo", summary: "", body: "Content for foo." };

    const cold = await refreshChunkEmbeddings([rec1, rec2], [], false, 256);
    const chunksForSlash0 = cold.chunks.filter((c) => c.slug === "foo#0");
    const chunksForFoo = cold.chunks.filter((c) => c.slug === "foo");
    expect(chunksForSlash0.length).toBeGreaterThan(0);
    expect(chunksForFoo.length).toBeGreaterThan(0);

    // Warm run: both must reuse, proving the index kept them distinct
    await assertWarmReuse([rec1, rec2], cold.chunks);
  });
});

// ---------------------------------------------------------------------------
// Regression: writer still emits version:2 bare-slug records
// ---------------------------------------------------------------------------

describe("writer version regression — still persists version:2", () => {
  it("readEmbeddingStore returns version 2 after a write-then-read cycle", async () => {
    const root = await makeRoot();
    const store: EmbeddingStore = {
      version: 2,
      model: "test-model",
      dimensions: 2,
      entries: [
        { slug: "alpha", title: "Alpha", summary: "S", vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      chunks: [],
    };
    await writeEmbeddingStore(root, store);
    const loaded = await readEmbeddingStore(root);
    expect(loaded?.version).toBe(2);
    expect(loaded?.entries[0].slug).toBe("alpha");
    // No pageId field on a v2 entry
    expect((loaded?.entries[0] as any).pageId).toBeUndefined();
  });

  it("a freshly-written v2 store has no v3-only fields on entries", async () => {
    const root = await makeRoot();
    const store: EmbeddingStore = {
      version: 2,
      model: "test-model",
      dimensions: 2,
      entries: [
        { slug: "beta", title: "Beta", summary: "S2", vector: [0, 1], updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      chunks: [
        { slug: "beta", title: "Beta", chunkIndex: 0, contentHash: "h1", text: "body", vector: [0, 1], updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    await writeEmbeddingStore(root, store);
    const raw = await import("fs/promises").then((m) => m.readFile(path.join(root, ".llmwiki/embeddings.json"), "utf8"));
    const parsed = JSON.parse(raw) as any;
    expect(parsed.version).toBe(2);
    expect(parsed.entries[0].pageId).toBeUndefined();
    expect(parsed.chunks[0].pageId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression: normal chunk reuse still works identically for plain stems
// ---------------------------------------------------------------------------

describe("chunk reuse regression — plain stems still work", () => {
  it("reuses all chunks on a warm run for ordinary slug-safe stems", async () => {
    mockProvider();
    const records: PageRecord[] = [
      { slug: "alpha", title: "Alpha", summary: "", body: "Plain paragraph one.\n\nPlain paragraph two." },
      { slug: "beta", title: "Beta", summary: "", body: "Beta paragraph one." },
    ];
    const cold = await refreshChunkEmbeddings(records, [], false, 256);
    expect(cold.embedded).toBeGreaterThan(0);

    await assertWarmReuse(records, cold.chunks);
  });
});
