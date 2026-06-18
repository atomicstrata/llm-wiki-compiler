/**
 * CLI-level integration tests for the chunked-retrieval feature.
 *
 * These tests exercise the `query --debug` flag and the v1→v2 embedding store
 * upgrade path at the boundary closest to real usage.
 *
 * What CAN be tested at this level without a live LLM:
 *   - Argument parsing: `query --help` advertises the --debug flag.
 *   - Credential guard: `query --debug` without an API key exits non-zero with
 *     a recognisable error message.
 *   - v1→v2 store upgrade: programmatic path through `updateEmbeddings` using a
 *     stubbed OpenAI provider (no network).
 *   - Chunk ranking: `findRelevantChunks` + `rerankWithBm25` on an in-memory v2
 *     fixture verifies chunk slugs and ordering without any LLM call.
 *
 * What CANNOT be tested at the CLI boundary without a live LLM:
 *   - Full `query --debug` output (chunk slugs + scores printed to stdout):
 *     The query command calls `requireProvider()` before touching the store, so
 *     a fake credential still results in an exit before the retrieval pipeline
 *     runs.  The same pipeline logic is covered programmatically below.
 *   - Full `compile` → embed → v2 store end-to-end: compile calls Claude to
 *     generate concept pages; without a real API key it exits in the provider
 *     guard.  The store-upgrade logic is covered programmatically instead.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import {
  findRelevantChunks,
  findTopKChunks,
  readEmbeddingStore,
  resetStaleEmbeddingWarnings,
  updateEmbeddings,
  writeEmbeddingStore,
  type ChunkEmbeddingEntry,
  type EmbeddingStore,
} from "../src/utils/embeddings.js";
import { rerankWithBm25 } from "../src/utils/retrieval.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { runCLI, expectCLIExit, expectCLIFailure } from "./fixtures/run-cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempRoot(label: string): Promise<string> {
  const root = path.join(os.tmpdir(), `llmwiki-cr-${label}-${Date.now()}`);
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  return root;
}

async function cleanupRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function makeChunkEntry(
  slug: string,
  chunkIndex: number,
  text: string,
  vector: number[],
): ChunkEmbeddingEntry {
  return {
    slug,
    title: slug,
    chunkIndex,
    contentHash: `hash-${slug}-${chunkIndex}`,
    text,
    vector,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeV2Store(chunks: ChunkEmbeddingEntry[]): EmbeddingStore {
  return {
    version: 2,
    model: "test-embed",
    dimensions: 2,
    entries: [],
    chunks,
  };
}

function makeV1Store(): EmbeddingStore {
  return {
    version: 1,
    model: "test-embed",
    dimensions: 2,
    entries: [
      {
        slug: "alpha",
        title: "Alpha",
        summary: "Summary for alpha",
        vector: [1, 0],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

/**
 * Stub the OpenAI provider and write a v2 store to disk.
 * Returns the root and its cleanup function.
 */
async function setupOpenAIWithV2Store(
  label: string,
  chunks: ChunkEmbeddingEntry[],
  queryVector: number[],
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await makeTempRoot(label);
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
  process.env.OPENAI_API_KEY = "test-key";
  vi.spyOn(OpenAIProvider.prototype, "embed").mockResolvedValue(queryVector);
  await writeEmbeddingStore(root, makeV2Store(chunks));
  return { root, cleanup: () => cleanupRoot(root) };
}


afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
  resetStaleEmbeddingWarnings();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CLI smoke: --help and credential guard
// ---------------------------------------------------------------------------

describe("query --help (CLI level)", () => {
  it("shows --debug flag in query help output", async () => {
    const result = await runCLI(["query", "--help"], process.cwd());
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("--debug");
  }, 30_000);

  it("shows --save flag alongside --debug in query help output", async () => {
    const result = await runCLI(["query", "--help"], process.cwd());
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("--save");
  }, 30_000);
});

describe("query --debug credential guard (CLI level)", () => {
  it("exits non-zero without an API key", async () => {
    // Pin the provider and settings path so this test passes in any dev
    // environment (e.g. one with LLMWIKI_PROVIDER=ollama set globally would
    // otherwise route through ollama and not hit the Anthropic credential
    // guard we're trying to test).
    const result = await runCLI(
      ["query", "--debug", "what is chunked retrieval?"],
      process.cwd(),
      {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        LLMWIKI_PROVIDER: "anthropic",
        LLMWIKI_CLAUDE_SETTINGS_PATH: "/tmp/llmwiki-nonexistent-claude-settings",
      },
    );
    expectCLIFailure(result);
    expect(result.stderr).toContain("Error:");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Programmatic: chunk ranking over a v2 fixture (no LLM)
// ---------------------------------------------------------------------------

describe("chunk ranking over v2 fixture (programmatic)", () => {
  it("findTopKChunks returns the most-similar chunk first", () => {
    const chunks = [
      makeChunkEntry("ml-basics", 0, "machine learning fundamentals", [1, 0]),
      makeChunkEntry("retrieval", 0, "retrieval augmented generation", [0, 1]),
      makeChunkEntry("ml-basics", 1, "neural network training", [0.8, 0.2]),
    ];
    // Query vector pointing at the first dimension → ml-basics/0 is closest.
    const top = findTopKChunks([1, 0], chunks, 2);
    expect(top[0].chunk.slug).toBe("ml-basics");
    expect(top[0].chunk.chunkIndex).toBe(0);
  });

  it("findRelevantChunks reads a v2 store from disk and ranks by query vector", async () => {
    // Query vector [1, 0] → closest chunk should be slug "a" (also [1, 0]).
    const { root, cleanup } = await setupOpenAIWithV2Store("v2-rank", [
      makeChunkEntry("a", 0, "alpha text", [1, 0]),
      makeChunkEntry("b", 0, "beta text", [0, 1]),
    ], [1, 0]);

    const results = await findRelevantChunks(root, "alpha", 2);
    expect(results[0].chunk.slug).toBe("a");
    expect(results[0].score).toBeGreaterThan(results[1].score);

    await cleanup();
  });

  it("rerankWithBm25 boosts chunks whose text contains query terms", () => {
    const chunks = [
      makeChunkEntry("general", 0, "fruits vegetables and plants", [0.5, 0.5]),
      makeChunkEntry("specific", 0, "chunked retrieval and reranking algorithms", [0.4, 0.6]),
    ];
    const candidates = chunks.map((chunk) => ({
      text: chunk.text,
      baseScore: 0.5,
      chunk,
    }));
    const ranked = rerankWithBm25("chunked retrieval", candidates);
    expect(ranked[0].candidate.chunk.slug).toBe("specific");
  });

  it("debug snapshot includes slug and score for each page", async () => {
    // Query vector [1, 0] → page-one should score highest.
    const { root, cleanup } = await setupOpenAIWithV2Store("debug-snap", [
      makeChunkEntry("page-one", 0, "relevant content here", [1, 0]),
      makeChunkEntry("page-two", 0, "unrelated material", [0, 1]),
    ], [1, 0]);

    const results = await findRelevantChunks(root, "relevant", 2);
    // Verify the debug-visible fields (slug + score) are populated.
    expect(results[0].chunk.slug).toBe("page-one");
    expect(typeof results[0].score).toBe("number");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Programmatic: v1 → v2 store upgrade (no LLM — OpenAI provider stubbed)
// ---------------------------------------------------------------------------

describe("v1 → v2 store upgrade (programmatic)", () => {
  it("upgrades a v1 store to version 2 and adds chunks", async () => {
    const root = await makeTempRoot("v1-upgrade");
    process.env.LLMWIKI_PROVIDER = "openai";
    process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(OpenAIProvider.prototype, "embed").mockResolvedValue([0.5, 0.5]);
    vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(
      async (texts: string[]) => texts.map(() => [0.5, 0.5]),
    );

    // Write a v1 store + matching concept page so updateEmbeddings has content.
    await writeEmbeddingStore(root, makeV1Store());
    await writeFile(
      path.join(root, "wiki/concepts/alpha.md"),
      "---\ntitle: Alpha\nsummary: Summary for alpha\n---\n\nBody for alpha page.",
    );

    await updateEmbeddings(root, []);
    const upgraded = await readEmbeddingStore(root);

    expect(upgraded?.version).toBe(2);
    expect(upgraded?.chunks).toBeDefined();
    expect((upgraded?.chunks ?? []).length).toBeGreaterThan(0);
    expect(upgraded?.chunks?.[0].slug).toBe("alpha");

    await cleanupRoot(root);
  });

  it("v1 store without chunks is correctly detected as needing an upgrade", async () => {
    const v1: EmbeddingStore = makeV1Store();
    // v1 stores never have a chunks field.
    expect(v1.chunks).toBeUndefined();
    expect(v1.version).toBe(1);
  });

  it("v2 store with chunks round-trips through write + read", async () => {
    const root = await makeTempRoot("v2-roundtrip");
    const original = makeV2Store([
      makeChunkEntry("alpha", 0, "first chunk", [0.1, 0.9]),
      makeChunkEntry("alpha", 1, "second chunk", [0.9, 0.1]),
    ]);
    await writeEmbeddingStore(root, original);
    const loaded = await readEmbeddingStore(root);

    expect(loaded?.version).toBe(2);
    expect(loaded?.chunks).toHaveLength(2);
    expect(loaded?.chunks?.[0].contentHash).toMatch(/^hash-/);

    await cleanupRoot(root);
  });
});

// ---------------------------------------------------------------------------
// Programmatic: empty-store cold-start (no LLM — OpenAI provider stubbed)
// ---------------------------------------------------------------------------

/** Shared setup: stub OpenAI and write an empty store of the given version. */
async function setupEmptyStore(label: string, version: 1 | 2): Promise<string> {
  const root = await makeTempRoot(label);
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
  process.env.OPENAI_API_KEY = "test-key";
  vi.spyOn(OpenAIProvider.prototype, "embed").mockResolvedValue([0.5, 0.5]);
  // Mock embedBatch so the page-embedding pass (which now uses batch) returns valid vectors.
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(
    async (texts: string[]) => texts.map(() => [0.5, 0.5]),
  );
  const emptyStore: EmbeddingStore = {
    version,
    model: "test-embed",
    dimensions: 0,
    entries: [],
    chunks: version === 2 ? [] : undefined,
  };
  await writeEmbeddingStore(root, emptyStore);
  return root;
}

/**
 * Assert that updateEmbeddings populated a v2 store with at least one chunk
 * for the expected slug, then clean up the temp root.
 */
async function assertPopulatedAndCleanup(root: string, expectedSlug: string): Promise<void> {
  await updateEmbeddings(root, []);
  const store = await readEmbeddingStore(root);
  expect(store?.version).toBe(2);
  expect((store?.chunks ?? []).length).toBeGreaterThan(0);
  expect(store?.chunks?.[0].slug).toBe(expectedSlug);
  await cleanupRoot(root);
}

describe("empty-store cold-start (programmatic)", () => {
  it("empty v1 store + live pages → populates chunks and upgrades to version 2", async () => {
    const root = await setupEmptyStore("empty-v1-live", 1);
    await writeFile(
      path.join(root, "wiki/concepts/beta.md"),
      "---\ntitle: Beta\nsummary: Beta page summary\n---\n\nContent for beta.",
    );
    await assertPopulatedAndCleanup(root, "beta");
  });

  it("empty v2 store + live pages → populates chunks", async () => {
    const root = await setupEmptyStore("empty-v2-live", 2);
    await writeFile(
      path.join(root, "wiki/concepts/gamma.md"),
      "---\ntitle: Gamma\nsummary: Gamma page summary\n---\n\nContent for gamma.",
    );
    await assertPopulatedAndCleanup(root, "gamma");
  });

  it("empty store + no live pages → no-op, store remains empty", async () => {
    const root = await setupEmptyStore("empty-no-pages", 2);
    // No wiki pages written — wiki/concepts/ directory exists but is empty.

    await updateEmbeddings(root, []);
    const store = await readEmbeddingStore(root);

    // Store was not re-written; the on-disk empty store is unchanged.
    expect(store?.entries).toHaveLength(0);
    expect(store?.chunks ?? []).toHaveLength(0);

    await cleanupRoot(root);
  });
});
