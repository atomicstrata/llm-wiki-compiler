/**
 * Actual write limits must preserve the prior index, not allocate an oversized
 * output or silently redirect to JSON. Shared input values limit fixture memory;
 * the production encoder still accounts for every logical record on disk.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { binaryFixture } from "./fixtures/binary-embedding-store.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { writeEmbeddingStore, EmbeddingStoreFullError, type EmbeddingStoreV3 } from "../src/utils/embeddings-store.js";
import { encodeBinaryStore, decodeBinaryStore } from "../src/utils/embeddings-binary.js";

const ctx = useConfinementRoots("binary-capacity");
afterEach(() => vi.unstubAllEnvs());

/** Each fixture exceeds one binding limit while retaining valid logical fields. */
function oversizedStore(kind: string): EmbeddingStoreV3 {
  const store = binaryFixture();
  store.chunks = [];
  const record = store.entries[0];
  if (kind === "metadata") {
    record.summary = "研".repeat(100_000);
    store.entries = Array.from({ length: 900 }, (_, index) => ({ ...record, pageId: `concepts/${index}` }));
  } else {
    store.dimensions = 4096;
    record.vector = Array.from({ length: 4096 }, () => 0.125);
    store.entries = Array.from({ length: 32_769 }, (_, index) => ({ ...record, pageId: `concepts/${index}` }));
  }
  return store;
}

it.each(["metadata", "payload"])("preserves the prior binary when %s exceeds its limit", async (kind) => {
  vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "true");
  await writeEmbeddingStore(ctx.root, binaryFixture());
  const directory = path.join(ctx.root, ".llmwiki");
  const file = path.join(directory, "embeddings.bin");
  const original = await readFile(file);
  const failure = writeEmbeddingStore(ctx.root, oversizedStore(kind));
  await expect(failure).rejects.toThrow(EmbeddingStoreFullError);
  await expect(failure).rejects.toThrow(kind === "metadata" ? /256 MiB/ : /512 MiB/);
  expect(await readFile(file)).toEqual(original);
  expect(await readdir(directory)).toEqual(["embeddings.bin"]);
}, 60_000);

it("retains 33,000 chunks of 1400-character CJK text within the metadata budget", () => {
  const store = binaryFixture();
  const chunk = store.chunks![0];
  store.chunks = Array.from({ length: 33_000 }, (_, index) => ({
    ...chunk, chunkIndex: index, text: `${index}:` + "研".repeat(1400 - `${index}:`.length),
  }));
  const bytes = encodeBinaryStore(store);
  const metadataBytes = bytes.readUInt32LE(8);
  expect(metadataBytes).toBeGreaterThan(128 * 1024 * 1024);
  const decoded = decodeBinaryStore(bytes) as unknown as EmbeddingStoreV3;
  expect(decoded.chunks).toHaveLength(33_000);
  expect(decoded.chunks![32_999].text).toBe("32999:" + "研".repeat(1394));
  console.info("embedding-long-text", JSON.stringify({ metadataBytes, bytes: bytes.length, dimensions: 2 }));
}, 60_000);
