/**
 * Real filesystem witnesses for binary selection, sticky authority and refusal.
 * A valid old JSON store must never conceal an unavailable newer binary store.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, open, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { binaryFixture } from "./fixtures/binary-embedding-store.js";
import { readStoreForUpdate, writeEmbeddingStore, resolveEmbeddingFingerprint } from "../src/utils/embeddings-store.js";
import { loadEmbeddingsForSearch } from "../src/utils/embeddings-load.js";
import { collectStats } from "../src/eval/stats.js";
import { readStoredEmbeddings } from "../src/utils/embeddings-storage.js";
import { MAX_BINARY_STORE_BYTES } from "../src/utils/embeddings-binary.js";

const ctx = useConfinementRoots("binary-store");
afterEach(() => vi.unstubAllEnvs());

/** Canonical derived-store filenames, independent of the format selector. */
function file(name: string): string { return path.join(ctx.root, ".llmwiki", name); }

describe("binary embedding persistence", () => {
  it("refuses an over-cap binary by size before reading it, never consulting JSON", async () => {
    await mkdir(file("."), { recursive: true });
    await writeFile(file("embeddings.json"), JSON.stringify(binaryFixture()));
    const handle = await open(file("embeddings.bin"), "w");
    try { await handle.truncate(MAX_BINARY_STORE_BYTES + 1); }
    finally { await handle.close(); }
    expect(await readStoredEmbeddings(ctx.root))
      .toEqual({ kind: "unavailable", reason: expect.stringMatching(/byte limit/) });
    expect(await readStoreForUpdate(ctx.root)).toBeNull();
  });

  it("keeps small default writes byte-identical JSON", async () => {
    vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "");
    const store = binaryFixture();
    await writeEmbeddingStore(ctx.root, store);
    expect(await readFile(file("embeddings.json"), "utf8")).toBe(JSON.stringify(store, null, 2));
    await expect(stat(file("embeddings.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads and writes binary without the opt-in after initial migration", async () => {
    vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "yes");
    await writeEmbeddingStore(ctx.root, binaryFixture());
    const first = await readFile(file("embeddings.bin"));
    expect(first.subarray(0, 8).toString()).toBe("LLMWEB01");
    vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "");
    await writeEmbeddingStore(ctx.root, { ...binaryFixture(), model: "updated" });
    expect((await readStoreForUpdate(ctx.root))?.store.model).toBe("updated");
    await expect(stat(file("embeddings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses corrupt binary despite a valid legacy backup, then repairs binary only", async () => {
    vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "");
    await writeEmbeddingStore(ctx.root, binaryFixture());
    const backup = await readFile(file("embeddings.json"));
    const before = await stat(file("embeddings.json"));
    await writeFile(file("embeddings.bin"), "bad");
    expect((await loadEmbeddingsForSearch(ctx.root)).warnings.map((warning) => warning.code))
      .toContain("embedding-store-unavailable");
    expect(await readStoreForUpdate(ctx.root)).toBeNull();
    await writeEmbeddingStore(ctx.root, { ...binaryFixture(), model: "repaired" });
    expect((await readStoreForUpdate(ctx.root))?.store.model).toBe("repaired");
    expect(await readFile(file("embeddings.json"))).toEqual(backup);
    expect((await stat(file("embeddings.json"))).mtimeMs).toBe(before.mtimeMs);
  });

  it("does not follow a binary symlink or silently write JSON instead", async () => {
    await mkdir(file("."), { recursive: true });
    const outside = path.join(ctx.outside, "target");
    await writeFile(outside, "untouched");
    await symlink(outside, file("embeddings.bin"));
    expect(await readStoreForUpdate(ctx.root)).toBeNull();
    await expect(writeEmbeddingStore(ctx.root, binaryFixture())).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("untouched");
    await expect(stat(file("embeddings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the binary counts and active fingerprint in stats and search", async () => {
    await mkdir(file("."), { recursive: true });
    await writeFile(file("embeddings.json"), JSON.stringify({ ...binaryFixture(), entries: [], chunks: [] }));
    vi.stubEnv("LLMWIKI_BINARY_EMBEDDINGS", "true");
    await writeEmbeddingStore(ctx.root, { ...binaryFixture(), fingerprint: resolveEmbeddingFingerprint() });
    expect((await loadEmbeddingsForSearch(ctx.root)).store?.entries).toHaveLength(2);
    const stats = await collectStats(ctx.root);
    expect(stats).toMatchObject({ embeddingCount: 2, chunkEmbeddingCount: 1 });
  });
});
