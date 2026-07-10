/**
 * @file test/embeddings-parse.test.ts
 * @description TDD tests for the version-discriminated parse / validate / read-for-update
 * split introduced in Task B3.
 *
 * Key invariants verified:
 *  - parseEmbeddingStore discriminates v1/v2/v3 WITHOUT running v3 id-validation
 *  - a v2 store with bare-slug records is NOT rejected by validateV3ForSearch
 *  - shared vector/integrity checks apply to v2 stores (bad vector → unavailable)
 *  - v3-only pageId/embeddingTextHash grammar does NOT run on v2 stores
 *  - readStoreForUpdate returns a v2 store so a migration can transform it later
 *  - normal v2 store round-trips identically (regression gate)
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseEmbeddingStore,
  validateV3ForSearch,
  readStoreForUpdate,
} from "../src/utils/embeddings-store.js";
import { EmbeddingIntegrityError } from "../src/utils/embeddings-validate.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("embed-parse");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDir(root: string): Promise<void> {
  return mkdir(path.join(root, ".llmwiki"), { recursive: true });
}

function writeRaw(root: string, obj: unknown): Promise<void> {
  return writeFile(
    path.join(root, ".llmwiki/embeddings.json"),
    JSON.stringify(obj, null, 2),
    "utf8",
  );
}

const VALID_VECTOR = [0.1, 0.9];
const BAD_VECTOR = [1, NaN];

function v2StoreObj(extras: Record<string, unknown> = {}) {
  return {
    version: 2,
    model: "m",
    dimensions: 2,
    entries: [{ slug: "bare-slug", title: "T", summary: "S", vector: VALID_VECTOR, updatedAt: "2026-01-01T00:00:00.000Z" }],
    chunks: [],
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// parseEmbeddingStore — structural version discrimination only
// ---------------------------------------------------------------------------

describe("parseEmbeddingStore — version discrimination", () => {
  it("parses a version:1 store and returns version 1", () => {
    const raw = { version: 1, model: "m", dimensions: 2, entries: [], chunks: [] };
    const result = parseEmbeddingStore(raw);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
  });

  it("parses a version:2 store and returns version 2", () => {
    const result = parseEmbeddingStore(v2StoreObj());
    expect(result?.version).toBe(2);
  });

  it("parses a version:3 store and returns version 3 without running v3 id-validation", () => {
    const v3Raw = { version: 3, model: "m", dimensions: 2, entries: [], chunks: [] };
    const result = parseEmbeddingStore(v3Raw);
    expect(result?.version).toBe(3);
  });

  it("returns null for an unknown version", () => {
    expect(parseEmbeddingStore({ version: 99, model: "m", dimensions: 2, entries: [] })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseEmbeddingStore(null)).toBeNull();
  });

  it("returns null for a non-object", () => {
    expect(parseEmbeddingStore("not-an-object")).toBeNull();
  });

  it("returns null when version is not numeric", () => {
    expect(parseEmbeddingStore({ version: "2", model: "m", dimensions: 2, entries: [] })).toBeNull();
  });

  it("does NOT reject a v2 store with bare-slug entries (no v3 id-validation)", () => {
    // bare-slug entries are valid v2; parseEmbeddingStore must not apply v3 grammar
    const result = parseEmbeddingStore(v2StoreObj());
    expect(result?.version).toBe(2);
    expect((result?.store as { entries: unknown[] }).entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// validateV3ForSearch — shared integrity + v3-only id stub
// ---------------------------------------------------------------------------

describe("validateV3ForSearch — shared integrity applies to v2 stores", () => {
  it("returns available with droppedIds=[] for a healthy v2 store", () => {
    const raw = v2StoreObj();
    const parsed = parseEmbeddingStore(raw)!;
    const result = validateV3ForSearch(parsed);
    expect(result.available).toBe(true);
    expect(result.droppedIds).toEqual([]);
  });

  it("marks unavailable when a v2 store has a bad vector (shared integrity check)", () => {
    const raw = v2StoreObj({ entries: [{ slug: "bad", title: "T", summary: "S", vector: BAD_VECTOR, updatedAt: "2026-01-01T00:00:00.000Z" }] });
    const parsed = parseEmbeddingStore(raw)!;
    const result = validateV3ForSearch(parsed);
    expect(result.available).toBe(false);
  });

  it("does NOT run v3-only pageId/embeddingTextHash validation on a v2 store", () => {
    // A v2 store has bare slugs — no pageId/embeddingTextHash fields
    // The function must not throw an integrity error due to missing v3-only fields
    const raw = v2StoreObj();
    const parsed = parseEmbeddingStore(raw)!;
    expect(() => validateV3ForSearch(parsed)).not.toThrow();
    const result = validateV3ForSearch(parsed);
    expect(result.available).toBe(true);
  });

  it("runs v3-only id validation stub for a v3 store (no false-positive on no ids)", () => {
    const v3Raw = { version: 3, model: "m", dimensions: 2, entries: [], chunks: [] };
    const parsed = parseEmbeddingStore(v3Raw)!;
    // v3 with empty entries — stub should not blow up
    const result = validateV3ForSearch(parsed);
    expect(result.available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readStoreForUpdate — write-path read, accepts v2 without v3-validation
// ---------------------------------------------------------------------------

describe("readStoreForUpdate — write-path v2 acceptance", () => {
  it("returns the v2 store for migration (does NOT validate as v3)", async () => {
    await makeDir(ctx.root);
    await writeRaw(ctx.root, v2StoreObj());
    const result = await readStoreForUpdate(ctx.root);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(2);
  });

  it("returns null on a clean project (no .llmwiki)", async () => {
    const result = await readStoreForUpdate(ctx.root);
    expect(result).toBeNull();
  });

  it("does not throw EmbeddingIntegrityError for a v2 store with bare-slug entries", async () => {
    await makeDir(ctx.root);
    await writeRaw(ctx.root, v2StoreObj());
    // Should succeed even though a v3 validator would reject bare slugs
    await expect(readStoreForUpdate(ctx.root)).resolves.not.toBeNull();
  });

  it("returns null when the file is corrupt JSON", async () => {
    await makeDir(ctx.root);
    await writeFile(path.join(ctx.root, ".llmwiki/embeddings.json"), "not-json", "utf8");
    const result = await readStoreForUpdate(ctx.root);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: normal v2 store reads and ranks identically (parity gate)
// ---------------------------------------------------------------------------

describe("v2 store parity regression", () => {
  it("a normal v2 store parses, validates, and round-trips without rejection", async () => {
    await makeDir(ctx.root);
    const obj = v2StoreObj();
    await writeRaw(ctx.root, obj);
    const parsed = parseEmbeddingStore(obj);
    expect(parsed?.version).toBe(2);
    const validation = validateV3ForSearch(parsed!);
    expect(validation.available).toBe(true);
    const forUpdate = await readStoreForUpdate(ctx.root);
    expect(forUpdate?.version).toBe(2);
    expect((forUpdate?.store as { entries: unknown[] }).entries).toHaveLength(1);
  });
});
