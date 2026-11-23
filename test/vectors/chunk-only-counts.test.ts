/**
 * @file test/vectors/chunk-only-counts.test.ts
 * @description Supported chunk-only imports must gain a page vector on ordinary
 * refresh and remain removable without corrupting counts. Small real-disk
 * fixtures use the existing deterministic 8D provider and throwing fetch.
 * activateIndexed is a fixture shortcut, not full preparation qualification.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { EMBEDDINGS_FILE } from "../../src/utils/constants.js";
import { resolveEmbeddingFingerprint } from "../../src/utils/embedding-identity.js";
import type { EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { findRelevantPagesV3, loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { updateEmbeddings } from "../../src/utils/embeddings.js";
import { pageMetaKey, pageVectorKey } from "../../src/vectors/contracts.js";
import { openVectorStore, readyVectorMeta } from "../../src/vectors/store.js";
import { verifyVectors } from "../../src/vectors/verify.js";
import { activateIndexed } from "../catalog/helpers.js";
import { embedded, expectVerifiedVectorBackup, useOfflineVectorFixture, vectorOf, writePage } from "./helpers.js";

const CHUNK_ONLY = "concepts/chunk-only";
const ORDINARY = "concepts/ordinary";
const fixture = useOfflineVectorFixture("llmwiki-chunk-counts-");

/** Derive a supported chunk-only incumbent by removing only one real page entry. */
async function seedLegacy(mixed: boolean): Promise<{ source: EmbeddingStoreV3; bytes: Buffer }> {
  const { root } = fixture;
  const ids = mixed ? [CHUNK_ONLY, ORDINARY] : [CHUNK_ONLY];
  for (const id of ids) await writePage(root, "concepts", id.split("/")[1]!, `${id} ${"words ".repeat(40)}`);
  await updateEmbeddings(root, ids);
  const backup = path.join(root, EMBEDDINGS_FILE);
  const incumbent = JSON.parse(await readFile(backup, "utf8")) as EmbeddingStoreV3;
  expect(incumbent).toMatchObject({ version: 3, model: "offline-embed", dimensions: 8, fingerprint: resolveEmbeddingFingerprint() });
  expect(incumbent.entries.map((entry) => entry.pageId).sort()).toEqual([...ids].sort());
  const chunks = incumbent.chunks!.filter((chunk) => chunk.pageId === CHUNK_ONLY);
  expect(chunks).toHaveLength(1);
  const chunk = chunks[0]!;
  expect(chunk).toMatchObject({ pageId: CHUNK_ONLY, chunkIndex: 0, vector: vectorOf(chunk.text) });
  expect(chunk.vector).toHaveLength(8);
  expect(chunk.vector.every(Number.isFinite)).toBe(true);
  const source = { ...incumbent, entries: incumbent.entries.filter((entry) => entry.pageId !== CHUNK_ONLY) };
  const bytes = Buffer.from(JSON.stringify(source));
  await writeFile(backup, bytes);
  return { source, bytes };
}

/** Import and directly activate through the existing labeled catalog fixture shortcut. */
async function activateChunkOnly(mixed = false): Promise<Buffer> {
  const { root } = fixture;
  const { source, bytes } = await seedLegacy(mixed);
  await activateIndexed(root);
  const store = await openVectorStore(root);
  expect(readyVectorMeta(store)).toMatchObject({ phase: "ready", pages: source.entries.length, chunks: source.chunks!.length });
  expect(await store.get(pageVectorKey(CHUNK_ONLY))).toBeUndefined();
  expect(await store.get(pageMetaKey(CHUNK_ONLY))).toMatchObject({
    embeddingTextHash: "", chunkHashes: [source.chunks!.find((chunk) => chunk.pageId === CHUNK_ONLY)!.contentHash],
    model: source.model, fingerprint: source.fingerprint,
  });
  await expectVerifiedVectorBackup(root, bytes);
  return bytes;
}

describe("counts after supported chunk-only vector imports", () => {
  /** Ordinary refresh must expose the first page vector to the page-level finder. */
  it("promotes a chunk-only import through ordinary refresh and page search", async () => {
    const { root } = fixture;
    const backup = await activateChunkOnly();
    expect(readyVectorMeta(await openVectorStore(root))).toMatchObject({ pages: 0, chunks: 1 });
    await updateEmbeddings(root, []);
    expect(readyVectorMeta(await openVectorStore(root)).pages).toBe(1);
    const { store } = await loadEmbeddingsForSearch(root);
    expect(store).not.toBeNull();
    const found = await findRelevantPagesV3(root, store!, "search", "chunk-only", 1);
    expect(found.hits.map((hit) => hit.pageId)).toEqual([CHUNK_ONLY]);
    expect(found.stalePageIds).toEqual([]);
    await expectVerifiedVectorBackup(root, backup);
  });

  /** Removing an unrefreshed chunk-only page must leave readable, empty ready state. */
  it("removes an unrefreshed chunk-only page through ordinary drain", async () => {
    const { root } = fixture;
    const backup = await activateChunkOnly();
    expect(readyVectorMeta(await openVectorStore(root))).toMatchObject({ pages: 0, chunks: 1 });
    await rm(path.join(root, "wiki", `${CHUNK_ONLY}.md`));
    await updateEmbeddings(root, []);
    const store = await openVectorStore(root);
    expect(readyVectorMeta(store)).toMatchObject({ phase: "ready", pages: 0, chunks: 0 });
    expect(await store.get(pageMetaKey(CHUNK_ONLY))).toBeUndefined();
    await expectVerifiedVectorBackup(root, backup);
  });

  /** Promotion must preserve ordinary metadata and an unchanged drain must do no work. */
  it("preserves mixed page counts and avoids work on unchanged drain", async () => {
    const { root } = fixture;
    const backup = await activateChunkOnly(true);
    const before = await openVectorStore(root);
    expect(readyVectorMeta(before)).toMatchObject({ pages: 1, chunks: 2 });
    const ordinary = await before.get(pageMetaKey(ORDINARY));
    const setupWork = embedded.texts;
    await updateEmbeddings(root, []);
    expect(readyVectorMeta(await openVectorStore(root)).pages).toBe(2);
    expect(await verifyVectors(root)).toMatchObject({ ok: true, problemCount: 0 });
    expect(await (await openVectorStore(root)).get(pageMetaKey(ORDINARY))).toEqual(ordinary);
    expect(embedded.texts).toBeGreaterThan(setupWork);
    const refreshedWork = embedded.texts;
    await updateEmbeddings(root, []);
    expect(readyVectorMeta(await openVectorStore(root)).pages).toBe(2);
    expect(embedded.texts).toBe(refreshedWork);
    await expectVerifiedVectorBackup(root, backup);
  });
});
