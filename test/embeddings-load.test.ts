/**
 * @file test/embeddings-load.test.ts
 * @description TDD for Task D3 — the degrade-aware pageId read pipeline.
 *
 * The on-disk store is STILL v2 until the D7 write-flip, so the surface loaders
 * must DEGRADE-on-read when they see a non-v3 store (store:null + a structured
 * `embedding-index-outdated` warning; lexical retrieval still works) and they
 * must NEVER mutate the store (READ-ONLY invariant). Against a hand-built v3
 * store they run the full prefilter → score → walk-ranked-freshness → live
 * rehydration pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import * as providerMod from "../src/utils/provider.js";
import { resolveEmbeddingModel, type EmbeddingStoreV3 } from "../src/utils/embeddings-store.js";
import { hashChunkText, splitIntoChunks } from "../src/utils/retrieval.js";
import { buildEmbeddingText } from "../src/utils/embeddings-pages.js";
import {
  loadEmbeddingsForSearch,
  loadEmbeddingsForContext,
  findRelevantPagesV3,
  findRelevantChunksV3,
} from "../src/utils/embeddings-load.js";
import type { LoadedProfile } from "../src/profile/types.js";

const EMB_FILE = ".llmwiki/embeddings.json";

/** Mock the provider so a query embeds to a fixed unit vector (no network). */
function mockQuery(vec: number[]): void {
  vi.spyOn(providerMod, "getProvider").mockReturnValue({
    embed: async () => vec,
    embedBatch: async (t: string[]) => t.map(() => vec),
  } as any);
}

/** Write a raw embeddings.json (verbatim) so byte-identity can be asserted. */
async function writeRawStore(root: string, raw: string): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, EMB_FILE), raw);
}

/** Persist a v3 store object as pretty JSON, stamped with the active model. */
async function writeV3Store(root: string, store: Omit<EmbeddingStoreV3, "model">): Promise<void> {
  await writeRawStore(root, JSON.stringify({ ...store, model: resolveEmbeddingModel() }, null, 2));
}

/** Live page hash for a concept page's embedding text (title + summary). */
function liveEmbHash(title: string, summary: string): string {
  return hashChunkText(buildEmbeddingText({ title, summary }));
}

describe("loadEmbeddingsForSearch — degrade on a non-v3 (v2) store", () => {
  it("returns store:null + embedding-index-outdated and leaves the v2 file byte-unchanged", async () => {
    const root = await makeTempRoot("load-degrade");
    const v2 = JSON.stringify({
      version: 2,
      model: resolveEmbeddingModel(),
      dimensions: 2,
      entries: [{ slug: "alpha", title: "Alpha", summary: "S", vector: [1, 0], updatedAt: "2026-01-01T00:00:00.000Z" }],
      chunks: [],
    }, null, 2);
    await writeRawStore(root, v2);

    const outcome = await loadEmbeddingsForSearch(root);
    expect(outcome.store).toBeNull();
    expect(outcome.warnings.map((w) => w.code)).toEqual(["embedding-index-outdated"]);

    const after = await readFile(path.join(root, EMB_FILE), "utf8");
    expect(after).toBe(v2); // READ-ONLY: byte-identical
  });

  it("returns store:null + embedding-index-outdated when no index file exists", async () => {
    const root = await makeTempRoot("load-absent");
    const outcome = await loadEmbeddingsForSearch(root);
    expect(outcome.store).toBeNull();
    expect(outcome.warnings[0].code).toBe("embedding-index-outdated");
  });

  it("loadEmbeddingsForContext also degrades on a v2 store", async () => {
    const root = await makeTempRoot("load-degrade-ctx");
    await writeRawStore(root, JSON.stringify({ version: 2, model: resolveEmbeddingModel(), dimensions: 2, entries: [], chunks: [] }, null, 2));
    const outcome = await loadEmbeddingsForContext(root);
    expect(outcome.store).toBeNull();
    expect(outcome.warnings[0].code).toBe("embedding-index-outdated");
  });

  it("loads a v3 store cleanly (store non-null, no warnings)", async () => {
    const root = await makeTempRoot("load-v3");
    await writeV3Store(root, {
      version: 3,
      dimensions: 2,
      entries: [{ pageId: "concepts/alpha", title: "Alpha", summary: "S", embeddingTextHash: "h", vector: [1, 0], updatedAt: "t" }],
      chunks: [],
    });
    const outcome = await loadEmbeddingsForSearch(root);
    expect(outcome.store?.version).toBe(3);
    expect(outcome.warnings).toEqual([]);
  });
});

describe("findRelevantPagesV3 — prefilter + freshness + rehydration", () => {
  it("drops a store entry whose pageId is not a live page (cheap identity prefilter)", async () => {
    const root = await makeTempRoot("prefilter");
    mockQuery([1, 0]);
    await writePage(path.join(root, "wiki/concepts"), "real", { title: "Real", summary: "rs" }, "body");
    const store: EmbeddingStoreV3 = {
      version: 3, model: resolveEmbeddingModel(), dimensions: 2,
      entries: [
        { pageId: "concepts/ghost", title: "Ghost", summary: "g", embeddingTextHash: "gh", vector: [1, 0], updatedAt: "t" },
        { pageId: "concepts/real", title: "Real", summary: "rs", embeddingTextHash: liveEmbHash("Real", "rs"), vector: [1, 0], updatedAt: "t" },
      ],
      chunks: [],
    };
    const { hits } = await findRelevantPagesV3(root, store, "search", "q", 5);
    expect(hits.map((h) => h.pageId)).toEqual(["concepts/real"]);
  });

  it("drops a stale-hash page and rehydrates title/summary from the LIVE file", async () => {
    const root = await makeTempRoot("freshness");
    mockQuery([1, 0]);
    await writePage(path.join(root, "wiki/concepts"), "drift", { title: "Live Title", summary: "live summary" }, "body");
    const store: EmbeddingStoreV3 = {
      version: 3, model: resolveEmbeddingModel(), dimensions: 2,
      entries: [
        { pageId: "concepts/drift", title: "STALE CACHED", summary: "stale cached", embeddingTextHash: "stalehash", vector: [1, 0], updatedAt: "t" },
      ],
      chunks: [],
    };
    const { hits, stalePageIds } = await findRelevantPagesV3(root, store, "search", "q", 5);
    expect(hits).toHaveLength(0);
    expect(stalePageIds).toEqual(["concepts/drift"]);
  });

  it("rehydrates a fresh page's title from the live file, never the cached store value", async () => {
    const root = await makeTempRoot("rehydrate");
    mockQuery([1, 0]);
    await writePage(path.join(root, "wiki/concepts"), "ok", { title: "Live Title", summary: "live sum" }, "body");
    const store: EmbeddingStoreV3 = {
      version: 3, model: resolveEmbeddingModel(), dimensions: 2,
      entries: [
        { pageId: "concepts/ok", title: "POISONED CACHED TITLE", summary: "poisoned", embeddingTextHash: liveEmbHash("Live Title", "live sum"), vector: [1, 0], updatedAt: "t" },
      ],
      chunks: [],
    };
    const { hits } = await findRelevantPagesV3(root, store, "search", "q", 5);
    expect(hits[0].title).toBe("Live Title");
    expect(hits[0].summary).toBe("live sum");
  });
});

describe("findRelevantChunksV3 — S7 stale-crowd-out + S12 rehydration", () => {
  it("returns a lower-score FRESH chunk over higher-score STALE chunks (no crowd-out)", async () => {
    const root = await makeTempRoot("crowdout");
    mockQuery([1, 0]); // cosine([1,0],·) ranks by first component
    // Two paragraphs each over CHUNK_TARGET_CHARS so they stay SEPARATE chunks.
    const body = `Alpha ${"a".repeat(900)}\n\nBeta ${"b".repeat(900)}`;
    await writePage(path.join(root, "wiki/concepts"), "page", { title: "Page", summary: "" }, body);
    const liveChunks = splitIntoChunks(body).map(hashChunkText);
    const store: EmbeddingStoreV3 = {
      version: 3, model: resolveEmbeddingModel(), dimensions: 2,
      entries: [],
      chunks: [
        // highest score, but STALE hash → must be dropped
        { pageId: "concepts/page", title: "Page", chunkIndex: 0, contentHash: "STALE", text: "stale top", vector: [1, 0], updatedAt: "t" },
        // lower score, FRESH hash → must be the returned hit
        { pageId: "concepts/page", title: "Page", chunkIndex: 1, contentHash: liveChunks[1], text: "ignored cached", vector: [0.5, 0.5], updatedAt: "t" },
      ],
    };
    const { hits } = await findRelevantChunksV3(root, store, "search", "q", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkIndex).toBe(1);
    // S12: text rehydrated from the LIVE body, not the cached "ignored cached"
    expect(hits[0].text).toBe(splitIntoChunks(body)[1]);
  });

  it("never surfaces a poisoned cached chunk.text (S12 rehydration)", async () => {
    const root = await makeTempRoot("poison");
    mockQuery([1, 0]);
    const body = "Only paragraph of the page body.";
    await writePage(path.join(root, "wiki/concepts"), "p", { title: "P", summary: "" }, body);
    const live0 = splitIntoChunks(body).map(hashChunkText)[0];
    const store: EmbeddingStoreV3 = {
      version: 3, model: resolveEmbeddingModel(), dimensions: 2,
      entries: [],
      chunks: [
        { pageId: "concepts/p", title: "P", chunkIndex: 0, contentHash: live0, text: "<script>POISON</script>", vector: [1, 0], updatedAt: "t" },
      ],
    };
    const { hits } = await findRelevantChunksV3(root, store, "search", "q", 5);
    expect(hits[0].text).toBe(splitIntoChunks(body)[0]);
    expect(hits[0].text).not.toContain("POISON");
  });
});

// ---------------------------------------------------------------------------
// Eligibility-parity prefilter (F2) — stale/forged v3 store cannot resurrect
// ineligible pages (orphaned / untitled / profile-invalid / search-excluded)
// ---------------------------------------------------------------------------

/** Wrap a ProfilePack as a LoadedProfile for use in findRelevantPagesV3. */
function asLoadedProfile(pack: { schemaVersion: 1; profileId: string; entities: Record<string, { directory: string; requiredFields?: string[]; fields?: Record<string, { type: string }>; retrieval?: Record<string, unknown> }> }): LoadedProfile {
  return { profile: pack as unknown as LoadedProfile["profile"], loadedFrom: null, digest: "" };
}

/** Build a minimal v3 store with one page entry (vector [1,0], no chunks). */
function singleEntryStore(pageId: string, title: string, summary: string, embHash: string): EmbeddingStoreV3 {
  return {
    version: 3, model: resolveEmbeddingModel(), dimensions: 2,
    entries: [{ pageId, title, summary, embeddingTextHash: embHash, vector: [1, 0], updatedAt: "t" }],
    chunks: [],
  };
}

/** Create `wiki/notes` inside root and return a LoadedProfile for the `notes` entity. */
async function setupNotesDir(root: string, entityDef: { directory: string; requiredFields?: string[]; fields?: Record<string, { type: string }>; retrieval?: Record<string, unknown> }): Promise<LoadedProfile> {
  const { mkdir } = await import("fs/promises");
  await mkdir(path.join(root, entityDef.directory), { recursive: true });
  return asLoadedProfile({ schemaVersion: 1, profileId: "t", entities: { notes: entityDef } });
}

describe("findRelevantPagesV3 — eligibility-parity prefilter (F2)", () => {
  it("drops a store entry for an orphaned concept — forged store cannot resurrect it", async () => {
    const root = await makeTempRoot("f2-orphaned");
    mockQuery([1, 0]);
    await writePage(path.join(root, "wiki/concepts"), "orphan", { title: "Ghost", orphaned: true }, "body");
    const store = singleEntryStore("concepts/orphan", "Ghost", "", liveEmbHash("Ghost", ""));
    const { hits } = await findRelevantPagesV3(root, store, "search", "q", 5);
    expect(hits.map((h) => h.pageId)).not.toContain("concepts/orphan");
  });

  it("drops a store entry for an untitled concept — forged store cannot resurrect it", async () => {
    const root = await makeTempRoot("f2-untitled");
    mockQuery([1, 0]);
    await writePage(path.join(root, "wiki/concepts"), "no-title", { summary: "s" }, "body");
    const store = singleEntryStore("concepts/no-title", "", "s", liveEmbHash("", "s"));
    const { hits } = await findRelevantPagesV3(root, store, "search", "q", 5);
    expect(hits.map((h) => h.pageId)).not.toContain("concepts/no-title");
  });

  it("drops a store entry for a profile-invalid typed page — matches writer invalidEntityPagePaths exclusion", async () => {
    const root = await makeTempRoot("f2-profile-invalid");
    mockQuery([1, 0]);
    // Profile requires title; page has none → field-violation → profile-invalid
    const profile = await setupNotesDir(root, { directory: "wiki/notes", requiredFields: ["title"], fields: { title: { type: "string" } } });
    await writePage(path.join(root, "wiki/notes"), "bad-note", {}, "body");
    const store = singleEntryStore("notes/bad-note", "", "", liveEmbHash("", ""));
    const { hits } = await findRelevantPagesV3(root, store, "search", "q", 5, profile);
    expect(hits.map((h) => h.pageId)).not.toContain("notes/bad-note");
  });

  it("drops a store entry for an includeInSearch:false typed page from SEARCH (forged-store guard)", async () => {
    const root = await makeTempRoot("f2-search-false");
    mockQuery([1, 0]);
    // includeInSearch:false → embedded:false for search surface; must not appear in search hits
    const profile = await setupNotesDir(root, { directory: "wiki/notes", retrieval: { includeInSearch: false } });
    await writePage(path.join(root, "wiki/notes"), "ctx-only", { title: "Context Only" }, "body");
    const store = singleEntryStore("notes/ctx-only", "Context Only", "", liveEmbHash("Context Only", ""));
    const { hits } = await findRelevantPagesV3(root, store, "search", "q", 5, profile);
    expect(hits.map((h) => h.pageId)).not.toContain("notes/ctx-only");
  });

  it("regression: a normal eligible concept passes the prefilter and is returned", async () => {
    const root = await makeTempRoot("f2-regression");
    mockQuery([1, 0]);
    await writePage(path.join(root, "wiki/concepts"), "eligible", { title: "Eligible", summary: "s" }, "body");
    const store = singleEntryStore("concepts/eligible", "Eligible", "s", liveEmbHash("Eligible", "s"));
    const { hits } = await findRelevantPagesV3(root, store, "search", "q", 5);
    expect(hits.map((h) => h.pageId)).toContain("concepts/eligible");
  });
});
