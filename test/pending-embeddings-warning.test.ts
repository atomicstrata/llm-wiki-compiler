/**
 * @file test/pending-embeddings-warning.test.ts
 * @description Unit coverage for the read-only pending-embeddings warning mapper
 * ({@link pendingEmbeddingsWarning}) and its `pending-embeddings` lint rule
 * ({@link checkPendingEmbeddings}), mirroring the journal-health surfacing.
 *
 * Pins: a clean project (no `.llmwiki`) maps to `null` / empty findings WITHOUT
 * creating `.llmwiki` (parity-safe, read-only); a planted marker with N entries
 * maps to the `embeddings-refresh-pending` warning naming N, and the lint rule
 * emits a single `warning` finding whose message is prefixed with the stable code.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { existsSync } from "fs";
import { mkdir, writeFile, symlink } from "fs/promises";
import path from "path";
import {
  PENDING_EMBEDDINGS_PENDING_CODE,
  PENDING_EMBEDDINGS_UNAVAILABLE_CODE,
  pendingEmbeddingsWarning,
} from "../src/trust/pending-embeddings-warning.js";
import { checkPendingEmbeddings } from "../src/linter/pending-embeddings-rule.js";
import { writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import {
  LLMWIKI_DIR,
  PENDING_EMBEDDINGS_FILE,
  MAX_PENDING_EMBEDDINGS_BYTES,
} from "../src/utils/constants.js";
import {
  makeRootWithOutside,
  cleanupRootWithOutside,
} from "./trust/fixture.js";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  ({ root, outsideDir } = await makeRootWithOutside("pending-embed-warn-"));
});

afterEach(async () => {
  await cleanupRootWithOutside({ root, outsideDir });
});

/** Plant a marker with `n` distinct pending page-ids. */
async function plantPending(n: number): Promise<void> {
  const entries = Array.from({ length: n }, (_, i) => ({ pageId: `concepts/p${i}`, attempts: 0 }));
  await writePendingEmbeddings(root, entries);
}

/** Absolute path to the marker leaf under `root/.llmwiki`. */
function markerPath(): string {
  return path.join(root, PENDING_EMBEDDINGS_FILE);
}

/** Plant a raw marker leaf with arbitrary bytes (real `.llmwiki` dir). */
async function plantRawMarker(body: string): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(markerPath(), body, "utf-8");
}

/** Plant the marker leaf as a symlink to an out-of-tree victim file. */
async function plantSymlinkedLeaf(): Promise<void> {
  const victim = path.join(outsideDir, "victim.json");
  await writeFile(victim, JSON.stringify(["concepts/a"]), "utf-8");
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await symlink(victim, markerPath(), "file");
}

describe("pendingEmbeddingsWarning", () => {
  it("returns null on a clean project, creating no .llmwiki (read-only)", async () => {
    expect(await pendingEmbeddingsWarning(root)).toBeNull();
    expect(existsSync(path.join(root, LLMWIKI_DIR))).toBe(false);
  });

  it("returns the pending warning naming the count when a marker exists", async () => {
    await plantPending(3);
    const warning = await pendingEmbeddingsWarning(root);
    expect(warning?.code).toBe(PENDING_EMBEDDINGS_PENDING_CODE);
    expect(warning?.message).toContain("3 page(s)");
  });

  it("returns the unavailable warning for a CORRUPT marker (invalid JSON)", async () => {
    await plantRawMarker("{not json");
    const warning = await pendingEmbeddingsWarning(root);
    expect(warning?.code).toBe(PENDING_EMBEDDINGS_UNAVAILABLE_CODE);
    expect(warning?.message).toContain(".llmwiki/pending-embeddings.json");
  });

  it.each(["{}", '{"entries":["concepts/a"]}', '"x"', "123", "true", "null"])(
    "returns the unavailable warning for a SCHEMA-invalid marker (valid JSON, non-array): %s",
    async (body) => {
      await plantRawMarker(body);
      expect((await pendingEmbeddingsWarning(root))?.code).toBe(PENDING_EMBEDDINGS_UNAVAILABLE_CODE);
    },
  );

  it("stays CLEAN for an empty array marker `[]` (no pending, not untrusted)", async () => {
    await plantRawMarker("[]");
    expect(await pendingEmbeddingsWarning(root)).toBeNull();
  });

  it("maps a legacy string-array marker to the pending warning", async () => {
    await plantRawMarker(JSON.stringify(["concepts/a"]));
    expect((await pendingEmbeddingsWarning(root))?.code).toBe(PENDING_EMBEDDINGS_PENDING_CODE);
  });

  it("maps a valid non-empty entry array to the pending warning", async () => {
    await plantRawMarker(JSON.stringify([{ pageId: "concepts/a", attempts: 0 }]));
    expect((await pendingEmbeddingsWarning(root))?.code).toBe(PENDING_EMBEDDINGS_PENDING_CODE);
  });

  it("returns the unavailable warning for an OVERSIZE marker (> byte cap)", async () => {
    await plantRawMarker(JSON.stringify(["concepts/" + "x".repeat(MAX_PENDING_EMBEDDINGS_BYTES)]));
    expect((await pendingEmbeddingsWarning(root))?.code).toBe(PENDING_EMBEDDINGS_UNAVAILABLE_CODE);
  });

  it("returns the unavailable warning for a SYMLINKED marker leaf", async () => {
    await plantSymlinkedLeaf();
    expect((await pendingEmbeddingsWarning(root))?.code).toBe(PENDING_EMBEDDINGS_UNAVAILABLE_CODE);
  });
});

describe("checkPendingEmbeddings", () => {
  it("emits no findings on a clean project (parity-safe)", async () => {
    expect(await checkPendingEmbeddings(root)).toEqual([]);
  });

  it("emits one warning prefixed with the code when a marker exists", async () => {
    await plantPending(2);
    const results = await checkPendingEmbeddings(root);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      rule: "pending-embeddings",
      severity: "warning",
      file: PENDING_EMBEDDINGS_FILE,
    });
    expect(results[0].message).toContain(`${PENDING_EMBEDDINGS_PENDING_CODE}:`);
    expect(results[0].message).toContain("2 page(s)");
  });

  it("surfaces the unavailable code for an untrustworthy (corrupt) marker", async () => {
    await plantRawMarker("{not json");
    const results = await checkPendingEmbeddings(root);
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain(`${PENDING_EMBEDDINGS_UNAVAILABLE_CODE}:`);
  });
});
