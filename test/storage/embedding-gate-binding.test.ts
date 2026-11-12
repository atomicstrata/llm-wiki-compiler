/**
 * @file test/storage/embedding-gate-binding.test.ts
 * @description The embedding surface loaders' degrade-on-read gate as ONE body
 * over one supplied stored read, `gateActiveStoreFrom`, with no project. This
 * file uses the body, which exists only after the gate was given its read, so it
 * has NO before-edit run.
 *
 * HOW IT IS BUILT. A memory read answers each stored-read outcome, so every
 * verdict is pinned: absent and unavailable, an older version, a store that
 * fails search validation, a store from a different configuration, a
 * configuration that cannot be resolved (degraded, never thrown), and the usable
 * v3 store under the active configuration. The composition is shown reaching the
 * stored reader's own body, and both surface loaders the incumbent read with
 * their root.
 *
 * NOT SHOWN HERE: the stored read itself, search validation's rules and the
 * fingerprint's derivation; the embedding storage, store and fingerprint suites
 * show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as storage from "../../src/utils/embeddings-storage.js";
import { gateActiveStoreFrom, loadEmbeddingsForContext, loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { resolveEmbeddingFingerprint, resolveEmbeddingModel } from "../../src/utils/embeddings-store.js";

afterEach(() => { vi.restoreAllMocks(); restoreEnv(); });

/** A valid v3 store under `fingerprint` (the active one by default). */
const v3 = (fingerprint = resolveEmbeddingFingerprint()) => ({
  version: 3, model: resolveEmbeddingModel(), fingerprint, dimensions: 2,
  entries: [{ pageId: "concepts/alpha", title: "A", summary: "", embeddingTextHash: "h", vector: [1, 0], updatedAt: "t" }], chunks: [],
});

/** The gate over a memory read answering `read`: its outcome and how often it read. */
async function gate(read: storage.StoredEmbeddingRead) {
  let reads = 0;
  const outcome = await gateActiveStoreFrom(async () => { reads += 1; return read; });
  return [outcome.store === null ? null : "store", outcome.warnings, reads];
}

const parsed = (version: 1 | 2 | 3, store: Record<string, unknown>) => ({ kind: "parsed" as const, parsed: { version, store } });

describe("the degrade-on-read gate over one stored read", () => {
  it("G1 degrades an absent, unavailable or older store, each with its own warning, after one read", async () => {
    expect(await gate({ kind: "absent" })).toEqual([null, [{ code: "embedding-index-outdated", message: "No embedding index found." }], 1]);
    expect(await gate({ kind: "unavailable", reason: "oversize" })).toEqual([null, [{ code: "embedding-store-unavailable", message: "oversize" }], 1]);
    expect((await gate(parsed(2, { version: 2 })))[1]).toEqual([{ code: "embedding-index-outdated", message: "Embedding index is an older version; rebuild with 'llmwiki compile'." }]);
  });

  it("G2 degrades a store that fails search validation before consulting the configuration", async () => {
    // A WELL-FORMED pageId (namespace/page) with a bad vector: a malformed id would be
    // dropped before validation, leaving an empty store that validates.
    const corrupt = { ...v3("x"), entries: [{ pageId: "concepts/alpha", vector: "not-a-vector" }] };
    stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "not-a-provider");
    expect((await gate(parsed(3, corrupt)))[1]).toEqual([{ code: "embedding-store-unavailable", message: "Embedding index failed integrity validation; rebuilt on next compile." }]);
  });

  it("G3 degrades a store from another configuration, and an unresolvable configuration, without throwing", async () => {
    const other = [{ code: "embedding-index-outdated", message: "Embedding index was built with a different embedding configuration; rebuild with 'llmwiki compile'." }];
    expect((await gate(parsed(3, v3("sha256:other"))))[1]).toEqual(other);
    const store = v3();
    stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "not-a-provider");
    expect(resolveEmbeddingFingerprint).toThrow();
    expect((await gate(parsed(3, store)))[1]).toEqual(other);
  });

  it("G4 hands back the v3 store under the active configuration with no warning", async () => {
    const store = v3();
    const outcome = await gateActiveStoreFrom(async () => parsed(3, store));
    expect([outcome.store === (store as never), outcome.warnings, outcome.stalePageIds]).toEqual([true, [], []]);
  });
});

describe("the composition and the surface loaders", () => {
  it("B1 the gate reads through the stored reader's own body when composed over its reads", async () => {
    const body = vi.spyOn(storage, "readStoredEmbeddingsFrom").mockResolvedValue({ kind: "absent" });
    const reads = { tag: "reads" } as never;
    expect((await gateActiveStoreFrom(() => storage.readStoredEmbeddingsFrom(reads))).warnings[0]?.code).toBe("embedding-index-outdated");
    expect(body.mock.calls).toEqual([[reads]]);
  });

  it("B2 both surface loaders reach the incumbent stored read with their root, once each", async () => {
    const read = vi.spyOn(storage, "readStoredEmbeddings").mockResolvedValue({ kind: "absent" });
    await loadEmbeddingsForSearch("/project");
    await loadEmbeddingsForContext("/other");
    expect(read.mock.calls).toEqual([["/project"], ["/other"]]);
  });
});
