/**
 * @file test/scale/steps.test.ts
 * @description The two local preparation steps on real disk.
 *
 * The container step converts a JSON store to the binary container preserving
 * the WHOLE store (every metadata field, including unknown accepted ones, and
 * every vector value under float32 semantics), keeps the JSON as backup,
 * publishes byte-identical verified bytes, re-verifies an existing container,
 * and parks — never falling back to JSON — on an unreadable authoritative
 * container or an unconvertible store. The preflight compares free space with
 * the conservative estimate and parks when it is short or unmeasurable.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { capacityPreflightFrom, diskEmbeddingContainerIo, float32Expected, prepareEmbeddingContainerFrom } from "../../src/scale/steps.js";
import { decodeBinaryStore, encodeBinaryStore } from "../../src/utils/embeddings-binary.js";
import { readStoredEmbeddings } from "../../src/utils/embeddings-storage.js";
import { binaryFixture } from "../fixtures/binary-embedding-store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-steps-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A leaf of the project's private directory. */
const leaf = (name: string): string => path.join(root, ".llmwiki", name);

/** Plant a JSON store (as the legacy writer would) and return it. */
async function plantJson(store: object = { ...binaryFixture(), retainedField: { note: "kept" } }): Promise<object> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(leaf("embeddings.json"), JSON.stringify(store, null, 2));
  return store;
}

describe("converting an existing JSON embedding store", () => {
  it("publishes a container holding the whole store under float32 semantics, keeping the JSON backup", async () => {
    const store = await plantJson();
    const jsonBefore = await readFile(leaf("embeddings.json"));
    expect(await prepareEmbeddingContainerFrom(diskEmbeddingContainerIo(root))).toMatchObject({ status: "done" });
    const bytes = await readFile(leaf("embeddings.bin"));
    expect(decodeBinaryStore(bytes)).toEqual(float32Expected(store as Record<string, unknown>));
    expect((decodeBinaryStore(bytes) as { retainedField: unknown }).retainedField).toEqual({ note: "kept" });
    expect((decodeBinaryStore(bytes) as { entries: Array<{ vector: number[] }> }).entries[0]!.vector[0]).toBe(Math.fround(0.1));
    expect(bytes.equals(encodeBinaryStore(store as never))).toBe(true);
    expect(await readFile(leaf("embeddings.json"))).toEqual(jsonBefore);
  });

  it("re-verifies an existing container on resume and reports whether the backup agrees", async () => {
    await plantJson();
    const io = diskEmbeddingContainerIo(root);
    await prepareEmbeddingContainerFrom(io);
    const before = await readFile(leaf("embeddings.bin"));
    expect(await prepareEmbeddingContainerFrom(io)).toEqual({ status: "done", detail: "binary container verified; matches the JSON backup" });
    expect(await readFile(leaf("embeddings.bin"))).toEqual(before);
  });

  it("finishes with nothing to convert when there is no store or no private directory", async () => {
    expect((await prepareEmbeddingContainerFrom(diskEmbeddingContainerIo(root))).status).toBe("done");
    await mkdir(path.join(root, ".llmwiki"));
    expect((await prepareEmbeddingContainerFrom(diskEmbeddingContainerIo(root))).status).toBe("done");
  });
});

describe("refusing to convert or trust what it cannot prove", () => {
  it("parks on an unreadable authoritative container and never falls back to the JSON", async () => {
    await plantJson();
    await writeFile(leaf("embeddings.bin"), "corrupt");
    expect((await prepareEmbeddingContainerFrom(diskEmbeddingContainerIo(root))).status).toBe("parked");
    expect((await readStoredEmbeddings(root)).kind).toBe("unavailable");
    expect(await readFile(leaf("embeddings.bin"), "utf8")).toBe("corrupt");
  });

  it("parks on an unreadable or invalid JSON store without writing a container", async () => {
    await mkdir(path.join(root, ".llmwiki"));
    await writeFile(leaf("embeddings.json"), "{ not json");
    expect((await prepareEmbeddingContainerFrom(diskEmbeddingContainerIo(root))).status).toBe("parked");
    await plantJson({ ...binaryFixture(), dimensions: 3 });
    expect(await prepareEmbeddingContainerFrom(diskEmbeddingContainerIo(root))).toMatchObject({ status: "parked" });
    await expect(readFile(leaf("embeddings.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parks when the published bytes do not read back identically", async () => {
    await plantJson();
    const io = diskEmbeddingContainerIo(root);
    const tampered = { ...io, afterBinaryWrite: async () => { await writeFile(leaf("embeddings.bin"), "changed under us"); } };
    expect((await prepareEmbeddingContainerFrom(tampered)).status).toBe("parked");
  });
});

describe("the disk-space preflight", () => {
  it("passes at or above the estimate and parks below it or when unmeasurable", async () => {
    expect((await capacityPreflightFrom({ freeBytes: async () => 100 }, 100)).status).toBe("done");
    expect(await capacityPreflightFrom({ freeBytes: async () => 99 }, 100)).toMatchObject({ status: "parked", detail: expect.stringContaining("insufficient-disk") });
    expect((await capacityPreflightFrom({ freeBytes: async () => { throw new Error("EIO"); } }, 1)).status).toBe("parked");
  });
});
