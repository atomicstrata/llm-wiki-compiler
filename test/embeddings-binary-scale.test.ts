/**
 * Reported-corpus disk witness: automatic format selection must preserve 900
 * pages and 33,000 text-bearing chunks, not merely fit an empty-vector estimate.
 * No provider is involved. Measurements include fixture construction and the
 * test worker's overhead; they are not provider latency or constant-memory claims.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { readStoreForUpdate, writeEmbeddingStore, type EmbeddingStoreV3 } from "../src/utils/embeddings-store.js";
import { cosineSimilarity } from "../src/utils/embeddings-search.js";

const PAGES = 900;
const CHUNKS = 33_000;
const DIMENSIONS = 1024;
const TEXT_CHARS = 800;
const ctx = useConfinementRoots("binary-scale");
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Deterministic nonzero decimal vectors expose Float32 rounding and ordering. */
function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, column) => Math.sin(seed + column + 1) / 32);
}

/** Unique content hashes and per-page chunk positions model real logical records. */
function scaleStore(): EmbeddingStoreV3 {
  const updatedAt = "2026-09-10T00:00:00.000Z";
  const entries = Array.from({ length: PAGES }, (_, index) => ({
    pageId: `concepts/page-${index}`, title: `Page ${index}`, summary: "Research evidence",
    embeddingTextHash: createHash("sha256").update(`Page ${index}`).digest("hex"),
    vector: vector(index), updatedAt,
  }));
  const chunks = Array.from({ length: CHUNKS }, (_, index) => {
    const text = (`研究結果と evidence ${index}: ` + "研究結果を比較して証拠を検証する。".repeat(TEXT_CHARS)).slice(0, TEXT_CHARS);
    return { pageId: entries[index % PAGES].pageId, title: entries[index % PAGES].title,
      chunkIndex: Math.floor(index / PAGES), text,
      contentHash: createHash("sha256").update(text).digest("hex"),
      vector: vector(PAGES + index), updatedAt };
  });
  return { version: 3, model: "offline-scale", dimensions: DIMENSIONS, entries, chunks };
}

/** Read only the physical header rather than allocating another complete file. */
async function metadataLength(file: string): Promise<number> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, header.length, 0);
    expect(header.subarray(0, 8).toString()).toBe("LLMWEB01");
    return header.readUInt32LE(8);
  } finally { await handle.close(); }
}

it("automatically persists and reloads the reported corpus without losing records or vectors", async () => {
  vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "");
  vi.stubGlobal("fetch", () => { throw new Error("NETWORK FORBIDDEN in scale witness"); });
  const started = performance.now();
  const source = scaleStore();
  await writeEmbeddingStore(ctx.root, source);
  const loaded = await readStoreForUpdate(ctx.root);
  expect(loaded?.version).toBe(3);
  const store = loaded!.store as unknown as EmbeddingStoreV3;
  expect(store.entries).toHaveLength(PAGES);
  expect(store.chunks).toHaveLength(CHUNKS);
  for (const index of [0, 16_500, 32_999]) {
    const actual = store.chunks![index];
    expect(actual).toEqual({ ...source.chunks![index], vector: source.chunks![index].vector.map(Math.fround) });
    expect(cosineSimilarity(actual.vector, source.chunks![index].vector)).toBeCloseTo(1, 10);
  }
  for (const index of [0, 450, 899]) {
    expect(store.entries[index]).toEqual({ ...source.entries[index], vector: source.entries[index].vector.map(Math.fround) });
  }
  const file = path.join(ctx.root, ".llmwiki/embeddings.bin");
  const bytes = (await stat(file)).size;
  const metadataBytes = await metadataLength(file);
  expect(bytes).toBe(12 + metadataBytes + (PAGES + CHUNKS) * DIMENSIONS * 4);
  await expect(stat(path.join(ctx.root, ".llmwiki/embeddings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  console.info("embedding-scale", JSON.stringify({ bytes, metadataBytes,
    elapsedMs: Math.round(performance.now() - started), maxRssKiB: process.resourceUsage().maxRSS }));
}, 60_000);
