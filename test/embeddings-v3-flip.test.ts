/**
 * @file test/embeddings-v3-flip.test.ts
 * @description Acceptance tests for the atomic v3 flip (D4 + D7).
 *
 * Covers the writer-side acceptance matrix:
 *  - S1: a no-op change on a v2 store still migrates → persisted store version:3.
 *  - S11: the locked Core runs under a held lock without a deadlock; the wrapper
 *    self-locks when the caller holds none.
 *  - A2: a concept `foo` and a query `foo` are INDEPENDENT v3 records.
 *  - typed retrieval: an eligible typed entity page is embedded under its EntityId.
 *  - S2/CR8: a both-false typed page is NEVER sent to the provider.
 *  - A7: a reader leaves a v2 store byte-unchanged (read-only).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "fs/promises";
import path from "path";
import os from "os";
import { updateEmbeddings, updateEmbeddingsLockedCore } from "../src/utils/embeddings.js";
import { writeEmbeddingStore } from "../src/utils/embeddings-store.js";
import { acquireLockBlocking, releaseLock } from "../src/utils/lock.js";
import { loadEmbeddingsForSearch } from "../src/utils/embeddings-load.js";
import { refreshAfterImport } from "../src/import/okf-refresh.js";
import { EMBEDDINGS_FILE } from "../src/utils/constants.js";
import * as providerMod from "../src/utils/provider.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import { readV3Store, conceptId } from "./fixtures/v3-store.js";
import type { ProfilePack } from "../src/profile/types.js";

let embedCalls = 0;

/** Stub the active provider with a counting embed/embedBatch returning a fixed vector. */
function stubProvider(): void {
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
  embedCalls = 0;
  vi.spyOn(providerMod, "getProvider").mockReturnValue({
    embed: async () => { embedCalls += 1; return [0.5, 0.5]; },
    embedBatch: async (texts: string[]) => { embedCalls += texts.length; return texts.map(() => [0.5, 0.5]); },
  } as unknown as ReturnType<typeof providerMod.getProvider>);
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  vi.restoreAllMocks();
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-v3flip-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

async function writeConcept(root: string, slug: string, body = "Body."): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), `---\ntitle: ${slug}\nsummary: S ${slug}\n---\n\n${body}`);
}

async function writeQuery(root: string, slug: string, body = "Body."): Promise<void> {
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  await writeFile(path.join(root, "wiki/queries", `${slug}.md`), `---\ntitle: ${slug}\nsummary: S ${slug}\n---\n\n${body}`);
}

/** A minimal v2 store (one page) so the migration has a sub-v3 store to upgrade. */
function v2Store(): Parameters<typeof writeEmbeddingStore>[1] {
  return {
    version: 2,
    model: "test-embed",
    dimensions: 2,
    entries: [{ slug: "stale", title: "stale", summary: "", vector: [0.1, 0.9], updatedAt: "2026-01-01T00:00:00.000Z" }],
    chunks: [],
  };
}

describe("v3 flip — writer", () => {
  it("S1: a no-op change on a v2 store still migrates to version 3", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeConcept(root, "alpha");
    await writeEmbeddingStore(root, v2Store());

    await updateEmbeddings(root, []); // empty change set
    const store = await readV3Store(root);
    expect(store?.version).toBe(3);
  });

  it("S11: the Core runs under a held lock without a deadlock", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeConcept(root, "alpha");
    await acquireLockBlocking(root);
    try {
      await updateEmbeddingsLockedCore(root, [conceptId("alpha")]);
    } finally {
      await releaseLock(root);
    }
    const store = await readV3Store(root);
    expect(store?.entries.some((e) => e.pageId === conceptId("alpha"))).toBe(true);
  });

  it("S11: the self-locking wrapper succeeds when the caller holds no lock", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeConcept(root, "alpha");
    await updateEmbeddings(root, [conceptId("alpha")]); // acquires + releases the lock itself
    const store = await readV3Store(root);
    expect(store?.version).toBe(3);
  });

  it("A2 (compile): a concept `foo` and a query `foo` are independent v3 records", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeConcept(root, "foo", "Concept foo body.");
    await writeQuery(root, "foo", "Query foo body.");

    await updateEmbeddings(root, [conceptId("foo"), "queries/foo"]);
    const store = await readV3Store(root);
    const ids = store?.entries.map((e) => e.pageId) ?? [];
    expect(ids).toContain("concepts/foo");
    expect(ids).toContain("queries/foo");
  });

  it("A2 (trusted OKF import): refreshAfterImport invalidates concepts/foo and queries/foo independently", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeConcept(root, "foo", "Concept foo body.");
    await writeQuery(root, "foo", "Query foo body.");
    // The OKF import path holds the lock and calls refreshAfterImport with the
    // qualified <targetDirectory>/<slug> ids the import wrote.
    await acquireLockBlocking(root);
    try {
      await refreshAfterImport(root, ["concepts/foo", "queries/foo"]);
    } finally {
      await releaseLock(root);
    }
    const ids = (await readV3Store(root))?.entries.map((e) => e.pageId) ?? [];
    expect(ids).toContain("concepts/foo");
    expect(ids).toContain("queries/foo");
  });
});

/** A profile with a `papers` type that opts a per-page surface in/out. */
function papersProfile(includeInSearch: boolean, includeInContext: boolean): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "papers-test",
    entities: {
      papers: { directory: "wiki/papers", retrieval: { includeInSearch, includeInContext } },
    },
  };
}

async function writeTypedPage(root: string, slug: string, body = "Typed body content."): Promise<void> {
  await mkdir(path.join(root, "wiki/papers"), { recursive: true });
  await writeFile(path.join(root, "wiki/papers", `${slug}.md`), `---\ntitle: ${slug}\nsummary: S ${slug}\n---\n\n${body}`);
}

describe("v3 flip — typed pages", () => {
  it("typed retrieval: an eligible typed page is embedded under its EntityId", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeProfileFile(root, papersProfile(true, true));
    await writeTypedPage(root, "foo");

    await updateEmbeddings(root, ["papers/foo"]);
    const store = await readV3Store(root);
    expect(store?.entries.some((e) => e.pageId === "papers/foo")).toBe(true);
  });

  it("S2/CR8: a both-false typed page is NEVER sent to the provider", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeProfileFile(root, papersProfile(false, false));
    await writeTypedPage(root, "secret");

    await updateEmbeddings(root, ["papers/secret"]);
    expect(embedCalls).toBe(0);
    const store = await readV3Store(root);
    expect(store?.entries.some((e) => e.pageId === "papers/secret")).toBeFalsy();
  });

  it("CR8: a symlinked-escaping typed page is NOT read or embedded", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeProfileFile(root, papersProfile(true, true));
    const outside = await mkdtemp(path.join(os.tmpdir(), "llmwiki-outside-"));
    await writeFile(path.join(outside, "leak.md"), "---\ntitle: Secret\nsummary: s\n---\nleaked");
    await mkdir(path.join(root, "wiki/papers"), { recursive: true });
    await symlink(path.join(outside, "leak.md"), path.join(root, "wiki/papers/leak.md"));

    await updateEmbeddings(root, ["papers/leak"]);
    expect(embedCalls).toBe(0); // escaping page dropped before the provider is called
    const store = await readV3Store(root);
    expect(store?.entries.some((e) => e.pageId === "papers/leak")).toBeFalsy();
  });

  it("papers/foo and concept foo are distinct embedded records", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeProfileFile(root, papersProfile(true, true));
    await writeConcept(root, "foo");
    await writeTypedPage(root, "foo");

    await updateEmbeddings(root, [conceptId("foo"), "papers/foo"]);
    const ids = (await readV3Store(root))?.entries.map((e) => e.pageId) ?? [];
    expect(ids).toContain("concepts/foo");
    expect(ids).toContain("papers/foo");
  });
});

describe("v3 flip — A7 read-only", () => {
  it("a reader leaves a v2 store byte-unchanged", async () => {
    const root = await makeRoot();
    stubProvider();
    await writeConcept(root, "alpha");
    await writeEmbeddingStore(root, v2Store());
    const before = await readFile(path.join(root, EMBEDDINGS_FILE), "utf-8");

    await loadEmbeddingsForSearch(root); // read-only v3 pipeline against a v2 store
    const after = await readFile(path.join(root, EMBEDDINGS_FILE), "utf-8");
    expect(after).toBe(before);
  });
});
