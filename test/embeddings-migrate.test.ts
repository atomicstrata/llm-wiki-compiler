/**
 * @file test/embeddings-migrate.test.ts
 * @description TDD tests for Task D5: the pure `migrateEmbeddingStore` core
 * (spec §4.4). Exercised with synthetic inputs only — the function never reads
 * the filesystem; the caller supplies `eligibleLivePages`.
 *
 * Invariants under test:
 *  - unambiguous + content-unchanged v2 page → vector preserved, re-keyed to the
 *    qualified pageId, `embeddingTextHash` stamped; NOT re-embedded.
 *  - changed content (recomputed hash differs) → re-embed.
 *  - a bare slug mapping to TWO eligible live pageIds (concept+query collision)
 *    → both discarded → both re-embed.
 *  - a v2 slug containing "/" → invalid → re-embed.
 *  - chunk preserved only on (contentHash, index) match; mismatch → re-embed.
 *  - S2 PRIVACY: an ineligible/opted-out page (bareSlug absent from
 *    `eligibleLivePages`) → dropped from the store AND never in `reembedPageIds`.
 *  - a deleted page (v2 entry, no eligible live page) → dropped, not re-embedded.
 *  - S5: stored model ≠ activeModel → rebuild-only; wrong-length vector → rebuild-only.
 *  - idempotent on a healthy v3 input.
 */

import { describe, it, expect } from "vitest";
import { migrateEmbeddingStore } from "../src/utils/embeddings-migrate.js";
import type { EligibleLivePage } from "../src/utils/embeddings-migrate.js";
import { buildEmbeddingText } from "../src/utils/embeddings-pages.js";
import { hashChunkText } from "../src/utils/retrieval.js";
import type { ParsedStore, EmbeddingStoreV3 } from "../src/utils/embeddings-store.js";
import type { PageId } from "../src/utils/page-id.js";

const MODEL = "voyage-3";
const VEC = [0.5, 0.5];

/** Build a parsed v2 store from raw entry/chunk arrays. */
function v2(entries: unknown[], chunks: unknown[] = []): ParsedStore {
  return { version: 2, store: { version: 2, model: MODEL, dimensions: 2, entries, chunks } };
}

/** A v2 page entry whose embedding text is `title`/`summary`. */
function v2Entry(slug: string, title: string, summary: string): Record<string, unknown> {
  return { slug, title, summary, vector: VEC, updatedAt: "2026-01-01T00:00:00.000Z" };
}

/** An eligible live page; hash defaults to the buildEmbeddingText hash of title/summary. */
function live(pageId: string, bareSlug: string, title: string, summary: string, chunks: string[] = []): EligibleLivePage {
  return {
    pageId,
    bareSlug,
    embeddingTextHash: hashText(buildEmbeddingText({ title, summary })),
    chunkContentHashes: chunks,
  };
}

/** Mirror the production hash (live registry uses hashChunkText) so inputs line up. */
function hashText(text: string): string {
  return hashChunkText(text);
}

/** Assert the migration preserved no page entries and re-embeds exactly `ids`. */
function expectReembedOnly(old: ParsedStore, pages: EligibleLivePage[], ids: PageId[]): void {
  const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
  expect(store.entries).toHaveLength(0);
  expect(reembedPageIds.sort()).toEqual([...ids].sort());
}

describe("migrateEmbeddingStore — page preservation", () => {
  it("preserves + re-keys + stamps an unambiguous unchanged page; not re-embedded", () => {
    const old = v2([v2Entry("foo", "Foo", "A summary")]);
    const pages = [live("concepts/foo", "foo", "Foo", "A summary")];
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
    expect(store.version).toBe(3);
    expect(store.entries).toHaveLength(1);
    const entry = store.entries[0];
    expect(entry.pageId).toBe("concepts/foo");
    expect(entry.vector).toEqual(VEC);
    expect(entry.embeddingTextHash).toBe(hashChunkText("Foo\n\nA summary"));
    expect(reembedPageIds).toHaveLength(0);
  });

  it("re-embeds a page whose content changed (recomputed hash differs)", () => {
    const old = v2([v2Entry("foo", "Foo", "OLD summary")]);
    expectReembedOnly(old, [live("concepts/foo", "foo", "Foo", "NEW summary")], ["concepts/foo"]);
  });

  it("discards a vector when a bare slug maps to TWO eligible live pageIds → both re-embed", () => {
    const old = v2([v2Entry("foo", "Foo", "S")]);
    const pages = [live("concepts/foo", "foo", "Foo", "S"), live("queries/foo", "foo", "Foo", "S")];
    expectReembedOnly(old, pages, ["concepts/foo", "queries/foo"]);
  });

  it("treats a v2 slug containing '/' as invalid → the live page re-embeds", () => {
    const old = v2([v2Entry("concepts/foo", "Foo", "S")]);
    expectReembedOnly(old, [live("concepts/foo", "foo", "Foo", "S")], ["concepts/foo"]);
  });

  it("embeds an eligible live page that has no v2 entry (new page)", () => {
    expectReembedOnly(v2([]), [live("concepts/new", "new", "New", "S")], ["concepts/new"]);
  });
});

describe("migrateEmbeddingStore — chunk preservation", () => {
  function v2Chunk(slug: string, idx: number, hash: string): Record<string, unknown> {
    return { slug, title: "T", chunkIndex: idx, contentHash: hash, text: "t", vector: VEC, updatedAt: "2026-01-01T00:00:00.000Z" };
  }

  it("preserves a chunk only on a (contentHash, index) match, re-keyed to the pageId", () => {
    const old = v2([v2Entry("foo", "Foo", "S")], [v2Chunk("foo", 0, "c0"), v2Chunk("foo", 1, "c1")]);
    const pages = [live("concepts/foo", "foo", "Foo", "S", ["c0", "c1"])];
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
    expect(store.chunks).toHaveLength(2);
    expect(store.chunks?.every((c) => c.pageId === "concepts/foo")).toBe(true);
    expect(reembedPageIds).toHaveLength(0);
  });

  it("drops a chunk whose stored contentHash differs → its page re-embeds", () => {
    const old = v2([v2Entry("foo", "Foo", "S")], [v2Chunk("foo", 0, "STALE")]);
    const pages = [live("concepts/foo", "foo", "Foo", "S", ["c0-fresh"])];
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
    expect(store.chunks).toHaveLength(0);
    expect(reembedPageIds).toEqual(["concepts/foo"]);
  });

  it("re-embeds on duplicate old chunk keys (same pageId+index)", () => {
    const old = v2([v2Entry("foo", "Foo", "S")], [v2Chunk("foo", 0, "c0"), v2Chunk("foo", 0, "c0")]);
    const pages = [live("concepts/foo", "foo", "Foo", "S", ["c0"])];
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
    expect(reembedPageIds).toEqual(["concepts/foo"]);
  });
});

describe("migrateEmbeddingStore — S2 eligibility-gated privacy", () => {
  it("drops an ineligible/opted-out page (bareSlug not in eligibleLivePages) and NEVER re-embeds it", () => {
    const old = v2([v2Entry("secret", "Secret", "private")]);
    const { store, reembedPageIds } = migrateEmbeddingStore(old, [], MODEL);
    expect(store.entries).toHaveLength(0);
    expect(reembedPageIds).toHaveLength(0);
  });

  it("drops a deleted page (v2 entry, no eligible live page) without re-embedding", () => {
    const old = v2([v2Entry("gone", "Gone", "S"), v2Entry("foo", "Foo", "S")]);
    const pages = [live("concepts/foo", "foo", "Foo", "S")];
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
    expect(store.entries.map((e) => e.pageId)).toEqual(["concepts/foo"]);
    expect(reembedPageIds).toHaveLength(0);
  });
});

describe("migrateEmbeddingStore — S5 rebuild-only gates", () => {
  it("rebuilds (empty store + all eligible in reembed) when stored model ≠ activeModel", () => {
    const old = v2([v2Entry("foo", "Foo", "S")]);
    const pages = [live("concepts/foo", "foo", "Foo", "S"), live("queries/bar", "bar", "Bar", "S")];
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, "a-different-model");
    expect(store.entries).toHaveLength(0);
    expect(store.chunks ?? []).toHaveLength(0);
    expect(reembedPageIds.sort()).toEqual(["concepts/foo", "queries/bar"]);
  });

  it("rebuilds when a vector has the wrong length (integrity failure)", () => {
    const bad = { slug: "foo", title: "Foo", summary: "S", vector: [0.5], updatedAt: "2026-01-01T00:00:00.000Z" };
    expectReembedOnly(v2([bad]), [live("concepts/foo", "foo", "Foo", "S")], ["concepts/foo"]);
  });

  it("rebuilds on a v1 store (no preservation possible)", () => {
    const old: ParsedStore = { version: 1, store: { version: 1, model: MODEL, dimensions: 2, entries: [] } };
    const pages = [live("concepts/foo", "foo", "Foo", "S")];
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
    expect(store.version).toBe(3);
    expect(reembedPageIds).toEqual(["concepts/foo"]);
  });

  it("rebuilds on a null/corrupt parsedOld", () => {
    const pages = [live("concepts/foo", "foo", "Foo", "S")];
    const { reembedPageIds } = migrateEmbeddingStore(null, pages, MODEL);
    expect(reembedPageIds).toEqual(["concepts/foo"]);
  });
});

describe("migrateEmbeddingStore — idempotent on v3", () => {
  it("returns a healthy v3 store unchanged with no spurious re-embed", () => {
    // The v3 idempotent path content-verifies against the live page, so the
    // entry's embeddingTextHash must equal the live page's computed hash to be
    // preserved unchanged (a drifted hash would re-embed — covered separately).
    const liveFoo = live("concepts/foo", "foo", "Foo", "S");
    const v3Store: EmbeddingStoreV3 = {
      version: 3,
      model: MODEL,
      dimensions: 2,
      entries: [
        { pageId: "concepts/foo", title: "Foo", summary: "S", embeddingTextHash: liveFoo.embeddingTextHash, vector: VEC, updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      chunks: [],
    };
    const parsed: ParsedStore = { version: 3, store: v3Store as unknown as Record<string, unknown> };
    const { store, reembedPageIds } = migrateEmbeddingStore(parsed, [liveFoo], MODEL);
    expect(store.entries).toEqual(v3Store.entries);
    expect(reembedPageIds).toHaveLength(0);
  });
});
