/**
 * @file test/ranking-parity-v2-v3.test.ts
 * @description Strong two-phase v2→v3 ranking-parity + collision-disambiguation
 * guard for PR4. The pre-existing ranking-baseline golden is a weak before/after
 * snapshot — it never proves the migration preserves *consumer-visible* ranking,
 * and never proves the three bare-slug collision classes PR4 exists to fix are
 * actually disambiguated. This file closes both gaps.
 *
 * Step-0 determination (drives the whole design): after the v3 flip a v2 store
 * DEGRADES on read — `gateActiveStore` (src/utils/embeddings-load.ts) returns
 * `{ store: null }` + an `embedding-index-outdated` warning whenever
 * `parsed.version !== 3`, so the live consumers (`generateAnswer`, `search_pages`)
 * NEVER score a raw v2 store. We therefore cannot capture "live v2 consumer
 * output". Instead the phase-1 baseline is the v3 consumer output AFTER migrating
 * a v2 store via `migrateEmbeddingStore`, asserted against the intended
 * pre-collision order with a hand-written expectation (no opaque golden).
 *
 * Three pillars:
 *  1. PRESERVE — an unambiguous v2 vector is content-verified-preserved
 *     byte-identical under its qualified pageId (not re-embedded), and a v3
 *     consumer ranks the migrated pages in the intended order.
 *  2. DISAMBIGUATE — a concept `foo`, a typed `papers/foo`, AND a query `foo`
 *     coexist; `generateAnswer` and the MCP `search_pages` tool each resolve the
 *     correctly-namespaced page and never cross-contaminate the other two.
 *  3. DIRECTION-OF-FIX — all three pages share the bare slug `foo` (what v2
 *     keyed on) yet carry three DISTINCT v3 pageIds, documenting why
 *     qualification was necessary and guarding a bare-slug-keying regression.
 *
 * All store entries use REAL hashes (`hashChunkText`/`buildEmbeddingText`/
 * `splitIntoChunks`) so the migration's content-verify can actually match.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writePage } from "./fixtures/write-page.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { mockQueryVector, PAPERS_PROFILE, chunkOf } from "./fixtures/typed-grounding.js";
import { buildServer, callTool } from "./fixtures/mcp-test-env.js";
import { migrateEmbeddingStore, type EligibleLivePage } from "../src/utils/embeddings-migrate.js";
import { buildEmbeddingText } from "../src/utils/embeddings-pages.js";
import { hashChunkText } from "../src/utils/retrieval.js";
import {
  writeEmbeddingStore,
  resolveEmbeddingModel,
  type ParsedStore,
  type EmbeddingStoreV3,
} from "../src/utils/embeddings-store.js";
import { findRelevantPagesV3 } from "../src/utils/embeddings-load.js";
import { loadProfile } from "../src/profile/load.js";
import type { PageRecord } from "../src/pages/read.js";

vi.mock("../src/utils/llm.js", () => ({
  // Echo the grounding context so the test can read which page body reached the
  // answer prompt (so cross-contamination is observable).
  callClaude: vi.fn(async (opts: { messages: Array<{ content: string }> }) => opts.messages[0].content),
}));

const MODEL = "test-embed";

/** Set provider env so `resolveEmbeddingModel()` returns MODEL for store stamping. */
function setProviderEnv(): void {
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLMWIKI_EMBEDDING_MODEL = MODEL;
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pillar 1 — migration preserves non-colliding ranking (content-verified)
// ---------------------------------------------------------------------------

/** A v2 page entry whose embedding text is `buildEmbeddingText({title, summary})`. */
function v2Entry(slug: string, title: string, summary: string, vector: number[]): Record<string, unknown> {
  return { slug, title, summary, vector, updatedAt: "2026-01-01T00:00:00.000Z" };
}

/** An eligible live page with REAL content hashes (no placeholders). */
function live(pageId: string, bareSlug: string, title: string, summary: string): EligibleLivePage {
  return { pageId, bareSlug, embeddingTextHash: hashChunkText(buildEmbeddingText({ title, summary })), chunkContentHashes: [] };
}

/** Wrap raw v2 entries in a ParsedStore the migration core accepts. */
function v2Store(entries: unknown[]): ParsedStore {
  return { version: 2, store: { version: 2, model: MODEL, dimensions: 2, entries, chunks: [] } };
}

describe("v2→v3 ranking parity — pillar 1: content-verified preserve", () => {
  // Two UNAMBIGUOUS bare slugs (alpha→concepts, beta→queries): each maps to
  // exactly one eligible live pageId, and the title/summary still hashes equal.
  const ALPHA_VEC = [0.96, 0.28];
  const BETA_VEC = [0.6, 0.8];
  const pages = [live("concepts/alpha", "alpha", "Alpha", "core"), live("queries/beta", "beta", "Beta", "edge")];
  const old = v2Store([v2Entry("alpha", "Alpha", "core", ALPHA_VEC), v2Entry("beta", "Beta", "edge", BETA_VEC)]);

  it("re-keys each unambiguous v2 vector byte-identical under its qualified pageId, no re-embed", () => {
    const { store, reembedPageIds } = migrateEmbeddingStore(old, pages, MODEL);
    expect(reembedPageIds).toHaveLength(0); // hash matched → preserved, not re-embedded
    const byId = new Map(store.entries.map((e) => [e.pageId, e]));
    expect(byId.get("concepts/alpha")?.vector).toEqual(ALPHA_VEC); // array-identical
    expect(byId.get("queries/beta")?.vector).toEqual(BETA_VEC);
    expect(byId.get("concepts/alpha")?.embeddingTextHash).toBe(hashChunkText("Alpha\n\ncore"));
  });

  it("a v3 consumer ranks the migrated pages in the intended (pre-collision) order", async () => {
    const root = await makeTempRoot("rank-preserve");
    try {
      await seedPreserveCorpus(root);
      setProviderEnv();
      mockQueryVector([1, 0]); // ranks the vector closest to [1,0] (alpha) first
      const { store } = migrateEmbeddingStore(old, pages, MODEL);
      await writeEmbeddingStore(root, store);
      const profile = await loadProfile(root);
      const { hits } = await findRelevantPagesV3(root, store, "search", "core?", 5, profile);
      expect(hits.map((h) => h.pageId)).toEqual(["concepts/alpha", "queries/beta"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Write the two live pages (concepts/alpha, queries/beta) the preserve pillar ranks. */
async function seedPreserveCorpus(root: string): Promise<void> {
  await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "core" }, "Alpha body.");
  await writePage(path.join(root, "wiki/queries"), "beta", { title: "Beta", summary: "edge" }, "Beta body.");
}

// ---------------------------------------------------------------------------
// Pillar 2 — the three collision classes are now disambiguated
// ---------------------------------------------------------------------------

const CONCEPT_BODY = "CONCEPT_FOO_BODY about a general idea.";
const PAPERS_BODY = "PAPERS_FOO_BODY about transformer scaling.";
const QUERY_BODY = "QUERY_FOO_BODY answering a saved question.";

/** Build a corpus with concept `foo`, typed `papers/foo`, AND query `foo` — same bare slug. */
async function buildCollisionCorpus(): Promise<string> {
  const root = await makeTempRoot("rank-collide");
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  await writeProfileFile(root, PAPERS_PROFILE);
  await writePage(path.join(root, "wiki/concepts"), "foo", { title: "Concept Foo", summary: "cs" }, CONCEPT_BODY);
  await writePage(path.join(root, "wiki/queries"), "foo", { title: "Query Foo", summary: "qs" }, QUERY_BODY);
  const papersDir = path.join(root, "wiki/papers");
  await mkdir(papersDir, { recursive: true });
  await writePage(papersDir, "foo", { title: "Paper Foo", summary: "ps" }, PAPERS_BODY);
  // One chunk per page, each aligned to a distinct unit axis so the query vector
  // can single out exactly one namespace. dimensions:3 so a 3-axis query embeds.
  const store: EmbeddingStoreV3 = {
    version: 3,
    model: resolveEmbeddingModel(),
    dimensions: 3,
    entries: [],
    chunks: [
      chunkOf("concepts/foo", CONCEPT_BODY, [1, 0, 0]),
      chunkOf("papers/foo", PAPERS_BODY, [0, 1, 0]),
      chunkOf("queries/foo", QUERY_BODY, [0, 0, 1]),
    ],
  };
  await writeFile(path.join(root, ".llmwiki", "embeddings.json"), JSON.stringify(store));
  return root;
}

/** The pageId that should rank FIRST for each query axis (the intended hit). */
const EXPECTED_ID: Record<string, string> = { "1,0,0": "concepts/foo", "0,1,0": "papers/foo", "0,0,1": "queries/foo" };
/**
 * The body each colliding page must resolve to. Because the three bodies are
 * globally unique, seeing ALL THREE present proves each `foo` ref loaded its OWN
 * namespaced file — a bare-slug regression would collapse all three refs to one
 * file, yielding ONE body repeated and the other two ABSENT.
 */
const ALL_BODIES = [CONCEPT_BODY, PAPERS_BODY, QUERY_BODY];

describe("v2→v3 ranking parity — pillar 2: collision classes disambiguated", () => {
  let generateAnswer: typeof import("../src/commands/query.js").generateAnswer;

  /** Build the collision corpus with the query vector aligned to one axis. */
  async function setupAxis(key: string): Promise<string> {
    setProviderEnv();
    const root = await buildCollisionCorpus();
    mockQueryVector(key.split(",").map(Number));
    ({ generateAnswer } = await import("../src/commands/query.js"));
    return root;
  }

  it.each(["1,0,0", "0,1,0", "0,0,1"])("generateAnswer ranks the %s-aligned namespace first, each foo on its own body", async (key) => {
    const root = await setupAxis(key);
    try {
      const result = await generateAnswer(root, "which foo?");
      expect(result.pageIds[0]).toBe(EXPECTED_ID[key]); // intended namespace ranks first
      expect(new Set(result.pageIds)).toEqual(new Set(["concepts/foo", "papers/foo", "queries/foo"]));
      // Every distinct body present → each foo resolved to its OWN file (no collapse).
      for (const body of ALL_BODIES) expect(result.answer).toContain(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["1,0,0", "0,1,0", "0,0,1"])("MCP search_pages ranks the %s-aligned page first, each foo on its own body", async (key) => {
    const root = await setupAxis(key);
    try {
      const envelope = await callTool(buildServer(root), "search_pages", { question: "which foo?" });
      const { pages, refs } = parseSearchResult(envelope);
      expect(refs[0]?.pageId).toBe(EXPECTED_ID[key]); // intended namespace ranks first
      expect(new Set(refs.map((r) => r.pageId))).toEqual(new Set(["concepts/foo", "papers/foo", "queries/foo"]));
      const bodies = pages.map((p) => p.body).join("\n");
      for (const body of ALL_BODIES) expect(bodies).toContain(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Decode the `search_pages` envelope into its pages + refs payload. */
function parseSearchResult(envelope: import("./fixtures/mcp-test-env.js").McpToolEnvelope): {
  pages: PageRecord[];
  refs: Array<{ pageId: string }>;
} {
  const payload = (envelope.structuredContent?.result ?? JSON.parse(envelope.content[0].text)) as {
    pages: PageRecord[];
    refs: Array<{ pageId: string }>;
  };
  return payload;
}

// ---------------------------------------------------------------------------
// Pillar 3 — direction-of-fix: bare slug collapses, pageId disambiguates
// ---------------------------------------------------------------------------

describe("v2→v3 ranking parity — pillar 3: direction-of-fix", () => {
  const collide = [
    live("concepts/foo", "foo", "Concept Foo", "cs"),
    live("papers/foo", "foo", "Paper Foo", "ps"),
    live("queries/foo", "foo", "Query Foo", "qs"),
  ];

  it("all three pages share the v2 bare-slug key yet hold three DISTINCT v3 pageIds", () => {
    expect(new Set(collide.map((p) => p.bareSlug))).toEqual(new Set(["foo"])); // v2 would collapse to one key
    expect(new Set(collide.map((p) => p.pageId)).size).toBe(3); // v3 keeps them apart
  });

  it("a single v2 'foo' vector is DROPPED (ambiguous) and every colliding page re-embeds", () => {
    // This is exactly the bare-slug regression the qualification prevents: one v2
    // key cannot be re-keyed to three live pages, so none is preserved.
    const old = v2Store([v2Entry("foo", "Concept Foo", "cs", [0.5, 0.5])]);
    const { store, reembedPageIds } = migrateEmbeddingStore(old, collide, MODEL);
    expect(store.entries).toHaveLength(0);
    expect(reembedPageIds.sort()).toEqual(["concepts/foo", "papers/foo", "queries/foo"]);
  });
});
