/**
 * @file test/vectors/integrity.test.ts
 * @description Fail-closed and degrade behaviour of the piecewise vector
 * store on real disk, through the ordinary loaders: an unusable vector store
 * degrades the search and context loads as `embedding-store-unavailable`
 * (an unreadable scale authority still refuses); a corrupt piece met while
 * streaming becomes the context retrieval's existing warning; malformed
 * facts and a non-canonical chunk key are typed corruption; full
 * verification catches row families that disagree; and a top hit that
 * changes during a search with a full top K rejects with a typed error
 * instead of returning an inexact result. A full verification whose
 * metadata scan fails part-way closes every segment reader the other scans
 * opened and rethrows the original error.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { restoreEnv, restoreGlobals } from "../stubs.js";
import { retrieveSemanticChunks } from "../../src/context/retrieval.js";
import { IndexedStoreError } from "../../src/segments/contracts.js";
import { findRelevantPagesV3, loadEmbeddingsForContext, loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { updateEmbeddings } from "../../src/utils/embeddings.js";
import * as registry from "../../src/utils/page-registry.js";
import type { PageId } from "../../src/utils/page-id.js";
import { chunkVectorKey, pageMetaKey } from "../../src/vectors/contracts.js";
import { VectorSearchChangedError } from "../../src/vectors/search.js";
import { isShardedView, openVectorStore, vectorMetaOf, type ShardedVectorView } from "../../src/vectors/store.js";
import { verifyVectors } from "../../src/vectors/verify.js";
import { SegmentReader } from "../../src/segments/reader.js";
import { SegmentStore } from "../../src/segments/store.js";
import { activateIndexed } from "../catalog/helpers.js";
import { useOfflineEmbeddings, writePage } from "./helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-vec-int-")); useOfflineEmbeddings(); });
afterEach(async () => { vi.restoreAllMocks(); restoreEnv(); restoreGlobals(); await rm(root, { recursive: true, force: true }); });

const QUESTION = "what about topic three";
const PAGES = 6;

/** An active `local-indexed` project with `PAGES` embedded two-chunk pages. */
async function activeCorpus(): Promise<void> {
  const ids: PageId[] = [];
  for (let at = 0; at < PAGES; at += 1) {
    await writePage(root, "concepts", `p${at}`, `Topic ${at} first ${"words ".repeat(30)}\n\nTopic ${at} second ${"more ".repeat(30)}`);
    ids.push(`concepts/p${at}` as PageId);
  }
  await updateEmbeddings(root, ids);
  await activateIndexed(root);
}

/** The first segment file of the vector store. */
async function firstSegment(): Promise<string> {
  return path.join(root, ".llmwiki", "indexed", "vectors", (await openVectorStore(root)).manifest.runs[0]!.segments[0]!.name);
}

describe("an unusable vector store", () => {
  it("degrades the search and context loads as unavailable, with no backup fallback", async () => {
    await activeCorpus();
    await writeFile(path.join(root, ".llmwiki", "indexed", "vectors", "manifest.json"), "{}");
    for (const load of [loadEmbeddingsForSearch, loadEmbeddingsForContext]) {
      expect(await load(root)).toMatchObject({ store: null, warnings: [{ code: "embedding-store-unavailable" }] });
    }
    expect(await retrieveSemanticChunks(root, QUESTION, 3)).toMatchObject({ hits: [], warning: "embedding-store-missing" });
    await writeFile(path.join(root, ".llmwiki", "scale.json"), "not json");
    await expect(loadEmbeddingsForSearch(root)).rejects.toMatchObject({ name: "ScaleGateError" });
  });

  it("turns a corrupt piece met while streaming into the context retrieval's warning", async () => {
    await activeCorpus();
    const segment = await firstSegment();
    const bytes = await readFile(segment);
    bytes[10] = bytes[10]! ^ 1;
    await rm(segment);
    await writeFile(segment, bytes);
    expect(await retrieveSemanticChunks(root, QUESTION, 3)).toMatchObject({ hits: [], warning: "semantic-retrieval-error" });
  });
});

describe("a project indexed before it had any embeddings", () => {
  it("stamps the active configuration on the first write and serves search", async () => {
    await activateIndexed(root);
    await writePage(root, "concepts", "first", `First page ${"words ".repeat(40)}`);
    await updateEmbeddings(root, ["concepts/first" as PageId]);
    expect(vectorMetaOf(await openVectorStore(root))).toMatchObject({ model: "offline-embed", pages: 1, phase: "ready" });
    const { store } = await loadEmbeddingsForSearch(root);
    expect((await findRelevantPagesV3(root, store!, "search", QUESTION, 3)).hits).toHaveLength(1);
    expect(await verifyVectors(root)).toMatchObject({ ok: true });
  });
});

describe("strict facts and rows", () => {
  it("types absent and dimensionless non-empty facts as corruption, not a TypeError", async () => {
    expect(() => vectorMetaOf(Object.create(null) as never)).toThrow(IndexedStoreError);
    await activeCorpus();
    const store = await openVectorStore(root);
    const tampered = await store.commit({ meta: { ...vectorMetaOf(store), dimensions: 0 } });
    expect(() => vectorMetaOf(tampered)).toThrow(IndexedStoreError);
  });

  it("verifies clean, then reports a non-canonical chunk key, a lost metadata row and a mismatched chunk hash", async () => {
    await activeCorpus();
    expect(await verifyVectors(root)).toMatchObject({ ok: true, problemCount: 0 });
    const store = await openVectorStore(root);
    const canonical = chunkVectorKey("concepts/p1", 0);
    const row = await store.get(canonical) as Record<string, unknown>;
    await store.commit({ rows: [{ k: `${canonical.slice(0, canonical.lastIndexOf("\u0000"))}\u00000`, v: row }] });
    const forged = await verifyVectors(root);
    expect(forged.ok).toBe(false);
    expect(forged.problems.join("\n")).toContain("malformed");
    await rm(path.join(root, ".llmwiki", "indexed"), { recursive: true });
    await activateIndexed(root);
    const fresh = await openVectorStore(root);
    const chunk = { ...(await fresh.get(chunkVectorKey("concepts/p3", 0)) as object), contentHash: "x" };
    await fresh.commit({ rows: [{ k: chunkVectorKey("concepts/p3", 0), v: chunk }, { k: pageMetaKey("concepts/p2"), d: 1 }] });
    const report = (await verifyVectors(root)).problems.join("\n");
    expect(report).toContain("concepts/p2 has no metadata row");
    expect(report).toContain("concepts/p3#0 does not match");
  });
});

/** A search view whose scan, once finished, makes every later live read report changed content. */
async function racingView(): Promise<ShardedVectorView> {
  const { store } = await loadEmbeddingsForSearch(root);
  if (!isShardedView(store)) throw new Error("expected a sharded view");
  let scanned = false;
  const real = registry.readLiveContentHashesFrom;
  vi.spyOn(registry, "readLiveContentHashesFrom").mockImplementation(async (...args) => {
    const live = await real(...args);
    return scanned && live !== null ? { ...live, embeddingTextHash: "changed" } : live;
  });
  const segments = Object.create(store.store, { scan: { value: async function* (options: object) { yield* store.store.scan(options); scanned = true; } } });
  return { ...store, store: segments };
}

describe("a hit that changes during a search", () => {
  it("rejects with a typed error when the top K was full", async () => {
    await activeCorpus();
    await expect(findRelevantPagesV3(root, await racingView(), "search", QUESTION, 2)).rejects.toBeInstanceOf(VectorSearchChangedError);
  });

  it("drops and reports it when every fresh candidate was kept", async () => {
    await activeCorpus();
    const result = await findRelevantPagesV3(root, await racingView(), "search", QUESTION, PAGES + 5);
    expect([result.hits.length, result.stalePageIds.length]).toEqual([0, PAGES]);
  });
});

describe("a full vector verification that fails part-way", () => {
  it("closes every reader the page and chunk scans opened and rethrows the original error", async () => {
    await activeCorpus();
    const counts = { opened: 0, closed: 0 };
    const open = SegmentReader.open.bind(SegmentReader);
    vi.spyOn(SegmentReader, "open").mockImplementation(async (...args) => {
      const reader = await open(...args);
      counts.opened += 1;
      const close = reader.close.bind(reader);
      reader.close = async () => { counts.closed += 1; await close(); };
      return reader;
    });
    const scan = SegmentStore.prototype.scan;
    vi.spyOn(SegmentStore.prototype, "scan").mockImplementation(function (this: SegmentStore, options) {
      const rows = scan.call(this, options);
      if (options?.prefix !== "m:") return rows;
      return (async function* failsAfterFirst() { for await (const row of rows) { yield row; throw new Error("injected metadata failure"); } })();
    });
    await expect(verifyVectors(root)).rejects.toThrow("injected metadata failure");
    expect(counts.opened).toBeGreaterThan(0);
    expect(counts.closed).toBe(counts.opened);
  });
});
