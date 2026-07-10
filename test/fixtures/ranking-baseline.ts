/**
 * @file test/fixtures/ranking-baseline.ts
 * @description Deterministic ranking fixture for the consumer-shaped re-key
 * parity guard (Task B4). Builds a minimal DEFAULT project with a pre-populated
 * v2 embedding store using hand-crafted, provider-free vectors. The store model
 * name is tied to LLMWIKI_PROVIDER=openai + LLMWIKI_EMBEDDING_MODEL=test-embed
 * so the active-model checks in the retrieval layer accept the store without a
 * live provider. A mock `getProvider().embed` returns a fixed QUERY_VECTOR so
 * every cosine score is fully deterministic across runs.
 *
 * The four captured sections match what `query`/`search` and `context` actually
 * consume at runtime:
 *   (i)  pageTopK — `findTopK` page-level scores
 *   (ii) chunkTopK — `findTopKChunks` chunk-level scores
 *   (iii) collapsedPageOrder — `pickSearchSlugs` BM25-reranked page order
 *   (iv) contextPrimary — `rankPages` context-pack primary entries
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { vi } from "vitest";
import * as providerMod from "../../src/utils/provider.js";
import {
  findTopK,
  findTopKChunks,
  writeEmbeddingStore,
  resetStaleEmbeddingWarnings,
  updateEmbeddings,
  type EmbeddingStore,
} from "../../src/utils/embeddings.js";
import { pickSearchSlugs } from "../../src/search/retrieval.js";
import { retrieveSemanticChunks } from "../../src/context/retrieval.js";
import { rankPages } from "../../src/context/ranking.js";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import {
  CONCEPTS_DIR,
  QUERIES_DIR,
  INDEX_FILE,
  STATE_FILE,
  SOURCES_DIR,
  CHUNK_TOP_K,
  EMBEDDING_TOP_K,
} from "../../src/utils/constants.js";

/** The fixed query string used to drive all four ranking sections. */
export const BASELINE_QUERY = "alpha core concepts";

/**
 * Fixed 3-dimensional query vector. Deliberately non-unit so the cosine
 * similarity function normalises it — choosing [1, 0, 0] makes the similarity
 * equal to the first component of each normalized page/chunk vector, giving
 * a clean descending gradient when page vectors are ladder-spaced in dim-0.
 */
export const QUERY_VECTOR: number[] = [1, 0, 0];

/** Embedding model name in the store — must match resolveEmbeddingModel() under openai+test-embed. */
export const BASELINE_MODEL = "test-embed";

/** Minimum context-pack primaries to freeze (covers semantic + lexical paths). */
const CONTEXT_TOP_PAGES = 8;

/** The hand-crafted v2 embedding store used by all sections. */
export function buildBaselineStore(): EmbeddingStore {
  return {
    version: 2,
    model: BASELINE_MODEL,
    dimensions: 3,
    entries: buildPageEntries(),
    chunks: buildChunkEntries(),
  };
}

/** Four page entries with distinct cosine scores against QUERY_VECTOR. */
function buildPageEntries(): EmbeddingStore["entries"] {
  // Scores (cosine against [1,0,0]) = first component when normalized.
  return [
    { slug: "alpha", title: "Alpha", summary: "The core idea.", vector: [0.95, 0.31, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    { slug: "beta", title: "Beta", summary: "Beta concept.", vector: [0.6, 0.8, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    { slug: "gamma", title: "Gamma", summary: "Gamma concept.", vector: [0.3, 0.95, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    { slug: "what-is-alpha", title: "What is Alpha?", summary: "Generated answer.", vector: [0.8, 0.6, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
}

/**
 * Eight chunk entries (two per page) with strictly descending cosine scores.
 *
 * The `text` and `contentHash` values are the REAL outputs of
 * `splitIntoChunks(body)` / `hashChunkText(text)` for the page bodies written
 * by `buildBaselineProject`. Each page body has a first paragraph that exceeds
 * `CHUNK_TARGET_CHARS` (800 chars) so `splitIntoChunks` flushes it as chunk 0,
 * and a second paragraph (≥ 200 chars) that becomes chunk 1 without merging.
 * This keeps the v2 baseline self-consistent with the v3 migration: when the
 * migration reads the live page files and computes `chunkContentHashes`, those
 * hashes match the stored `contentHash` values here — so the vectors are
 * preserved rather than queued for re-embedding.
 */
function buildChunkEntries(): NonNullable<EmbeddingStore["chunks"]> {
  return [
    // alpha chunk 0 — text = splitIntoChunks(alphaBody)[0]; hash = hashChunkText(text)
    { slug: "alpha", title: "Alpha", chunkIndex: 0, contentHash: "dfb0fa7719a3cd21", text: "Alpha establishes the core idea and forms the foundation of the entire knowledge base. It represents the starting point from which all concepts in this system derive their meaning, and understanding Alpha is the prerequisite for understanding any other element in the knowledge base. Alpha defines the primary abstractions and establishes the vocabulary that subsequent concepts build upon. The core idea encapsulated in Alpha predates all other components and serves as the axiomatic foundation for all reasoning. Alpha is referenced by every other page in the wiki, directly or transitively.", vector: [0.98, 0.2, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    // alpha chunk 1 — text = splitIntoChunks(alphaBody)[1]
    { slug: "alpha", title: "Alpha", chunkIndex: 1, contentHash: "ee56cbdc37dbaf1f", text: "Alpha is fundamental to understanding the system. Every derived concept, every query, and every relationship in the knowledge base ultimately traces back to Alpha as its origin. The primacy of Alpha ensures that all other knowledge is coherent and mutually consistent, since they all share the same foundational assumptions and definitions established here.", vector: [0.9, 0.44, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    // what-is-alpha chunk 0
    { slug: "what-is-alpha", title: "What is Alpha?", chunkIndex: 0, contentHash: "b922663fc87a4c56", text: "What is Alpha? Alpha is the core concept in this knowledge base, representing the foundational abstraction from which all other concepts derive their meaning and structure. Alpha was established as the primary definition because it captures the essential nature of the domain in the most concise and generalizable way possible. Every other page in the wiki either builds upon Alpha or references it as a definitional anchor for their own explanations and derivations. The answer to this question is the gateway to understanding the entire knowledge base and its interconnected structure of concepts, queries, and relationships.", vector: [0.85, 0.53, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    // what-is-alpha chunk 1
    { slug: "what-is-alpha", title: "What is Alpha?", chunkIndex: 1, contentHash: "83b97b038ab87994", text: "See the Alpha page for more details about the full definition, examples, and relationships to other concepts. The Alpha page is the authoritative source and contains all known properties, derived concepts, and references to source materials that informed the original synthesis of this core idea.", vector: [0.75, 0.66, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    // beta chunk 0
    { slug: "beta", title: "Beta", chunkIndex: 0, contentHash: "0a5937763c710c4e", text: "Beta is a related concept that builds directly on the foundations established by Alpha. It extends the core abstractions into a secondary tier of the knowledge hierarchy, providing concrete implementations and specialized derivatives of the primary ideas. Beta inherits the fundamental properties of Alpha while adding its own distinct characteristics that make it applicable to a broader range of scenarios and use cases within the system. Beta is the second most important concept in this knowledge base, and serves as the primary bridge between the core foundations and more peripheral concepts such as Gamma.", vector: [0.7, 0.71, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    // beta chunk 1
    { slug: "beta", title: "Beta", chunkIndex: 1, contentHash: "489c12da9bc0ce5e", text: "Beta extends from the baseline established by Alpha and introduces new patterns that are referenced by downstream concepts. Understanding Beta requires familiarity with Alpha, but Beta's unique contributions stand on their own as a distinct tier of abstraction within the system.", vector: [0.5, 0.87, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    // gamma chunk 0
    { slug: "gamma", title: "Gamma", chunkIndex: 0, contentHash: "255a65b63bf69d77", text: "Gamma is a peripheral concept that occupies the outer layers of the knowledge hierarchy. While it is less central than Alpha or Beta, Gamma still plays an important role in capturing edge cases and specialized knowledge domains that fall outside the primary abstractions. Gamma concepts are typically queried less frequently but provide essential context when dealing with boundary conditions and advanced topics in the knowledge base. Its semantic embedding is important for comprehensive retrieval even though direct queries for Gamma are infrequent compared to Alpha and Beta.", vector: [0.4, 0.92, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
    // gamma chunk 1
    { slug: "gamma", title: "Gamma", chunkIndex: 1, contentHash: "80bbf4f27813b791", text: "Gamma is rarely queried in typical use cases, yet it remains a necessary part of a complete knowledge base. The peripheral nature of Gamma concepts means they are often discovered through related searches rather than direct queries, and they serve as useful disambiguation anchors for the retrieval system when borderline cases arise.", vector: [0.2, 0.98, 0], updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
}

/**
 * Write the minimal project files the viewer snapshot builder requires:
 * sources/, wiki/concepts/, wiki/queries/, wiki/index.md, .llmwiki/state.json.
 */
export async function buildBaselineProject(root: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(root, CONCEPTS_DIR), { recursive: true }),
    mkdir(path.join(root, QUERIES_DIR), { recursive: true }),
    mkdir(path.join(root, SOURCES_DIR), { recursive: true }),
    mkdir(path.join(root, ".llmwiki"), { recursive: true }),
  ]);
  await writeConceptPages(root);
  await writeQueryPage(root);
  await writeIndex(root);
  await writeState(root);
}

/**
 * Write three concept pages with distinct textual content.
 *
 * Each page body has two paragraphs chosen so that `splitIntoChunks` produces
 * exactly two chunks: the first paragraph exceeds `CHUNK_TARGET_CHARS` (800
 * chars) so it is flushed immediately as chunk 0, and the second paragraph
 * is at least `CHUNK_MIN_CHARS` (200 chars) so it is emitted as chunk 1
 * without being merged back. The chunk `text`/`contentHash` values in
 * `buildChunkEntries` are derived from these exact paragraph strings.
 */
async function writeConceptPages(root: string): Promise<void> {
  const dir = path.join(root, CONCEPTS_DIR);
  const ts = "2026-01-01T00:00:00.000Z";
  // prettier-ignore
  await writePage(dir, "alpha", [
    `---`,
    `title: Alpha`,
    `summary: The core idea.`,
    `createdAt: ${ts}`,
    `updatedAt: ${ts}`,
    `---`,
    ``,
    `Alpha establishes the core idea and forms the foundation of the entire knowledge base. It represents the starting point from which all concepts in this system derive their meaning, and understanding Alpha is the prerequisite for understanding any other element in the knowledge base. Alpha defines the primary abstractions and establishes the vocabulary that subsequent concepts build upon. The core idea encapsulated in Alpha predates all other components and serves as the axiomatic foundation for all reasoning. Alpha is referenced by every other page in the wiki, directly or transitively.`,
    ``,
    `Alpha is fundamental to understanding the system. Every derived concept, every query, and every relationship in the knowledge base ultimately traces back to Alpha as its origin. The primacy of Alpha ensures that all other knowledge is coherent and mutually consistent, since they all share the same foundational assumptions and definitions established here.`,
    ``,
  ].join("\n"));
  // prettier-ignore
  await writePage(dir, "beta", [
    `---`,
    `title: Beta`,
    `summary: Beta concept.`,
    `createdAt: ${ts}`,
    `updatedAt: ${ts}`,
    `---`,
    ``,
    `Beta is a related concept that builds directly on the foundations established by Alpha. It extends the core abstractions into a secondary tier of the knowledge hierarchy, providing concrete implementations and specialized derivatives of the primary ideas. Beta inherits the fundamental properties of Alpha while adding its own distinct characteristics that make it applicable to a broader range of scenarios and use cases within the system. Beta is the second most important concept in this knowledge base, and serves as the primary bridge between the core foundations and more peripheral concepts such as Gamma.`,
    ``,
    `Beta extends from the baseline established by Alpha and introduces new patterns that are referenced by downstream concepts. Understanding Beta requires familiarity with Alpha, but Beta's unique contributions stand on their own as a distinct tier of abstraction within the system.`,
    ``,
  ].join("\n"));
  // prettier-ignore
  await writePage(dir, "gamma", [
    `---`,
    `title: Gamma`,
    `summary: Gamma concept.`,
    `createdAt: ${ts}`,
    `updatedAt: ${ts}`,
    `---`,
    ``,
    `Gamma is a peripheral concept that occupies the outer layers of the knowledge hierarchy. While it is less central than Alpha or Beta, Gamma still plays an important role in capturing edge cases and specialized knowledge domains that fall outside the primary abstractions. Gamma concepts are typically queried less frequently but provide essential context when dealing with boundary conditions and advanced topics in the knowledge base. Its semantic embedding is important for comprehensive retrieval even though direct queries for Gamma are infrequent compared to Alpha and Beta.`,
    ``,
    `Gamma is rarely queried in typical use cases, yet it remains a necessary part of a complete knowledge base. The peripheral nature of Gamma concepts means they are often discovered through related searches rather than direct queries, and they serve as useful disambiguation anchors for the retrieval system when borderline cases arise.`,
    ``,
  ].join("\n"));
}

/** Write the single query page. */
async function writeQueryPage(root: string): Promise<void> {
  const dir = path.join(root, QUERIES_DIR);
  const ts = "2026-01-01T00:00:00.000Z";
  // prettier-ignore
  await writePage(dir, "what-is-alpha", [
    `---`,
    `title: What is Alpha?`,
    `summary: Generated answer.`,
    `createdAt: ${ts}`,
    `updatedAt: ${ts}`,
    `---`,
    ``,
    `What is Alpha? Alpha is the core concept in this knowledge base, representing the foundational abstraction from which all other concepts derive their meaning and structure. Alpha was established as the primary definition because it captures the essential nature of the domain in the most concise and generalizable way possible. Every other page in the wiki either builds upon Alpha or references it as a definitional anchor for their own explanations and derivations. The answer to this question is the gateway to understanding the entire knowledge base and its interconnected structure of concepts, queries, and relationships.`,
    ``,
    `See the Alpha page for more details about the full definition, examples, and relationships to other concepts. The Alpha page is the authoritative source and contains all known properties, derived concepts, and references to source materials that informed the original synthesis of this core idea.`,
    ``,
  ].join("\n"));
}

/** Write a plain text file at dir/stem.md. */
async function writePage(dir: string, stem: string, content: string): Promise<void> {
  await writeFile(path.join(dir, `${stem}.md`), content, "utf-8");
}

/** Write wiki/index.md. */
async function writeIndex(root: string): Promise<void> {
  const body = "# Wiki Index\n\n## Concepts\n- [[alpha]]\n- [[beta]]\n- [[gamma]]\n\n## Queries\n- [[what-is-alpha]]\n";
  await writeFile(path.join(root, INDEX_FILE), body, "utf-8");
}

/** Write a minimal .llmwiki/state.json so the snapshot builder succeeds. */
async function writeState(root: string): Promise<void> {
  const state = { version: 1, indexHash: "", sources: {} };
  await writeFile(path.join(root, STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}

/** The four sections of the ranking baseline golden. */
export interface RankingBaseline {
  /** (i) Page top-K: slug + rounded score, descending. */
  pageTopK: Array<{ slug: string; score: number }>;
  /** (ii) Chunk top-K: slug + chunkIndex + rounded score, descending. */
  chunkTopK: Array<{ slug: string; chunkIndex: number; score: number }>;
  /** (iii) Collapsed page order from pickSearchSlugs (chunk-first BM25 rerank). */
  collapsedPageOrder: string[];
  /** (iv) Context-pack primary entries: id + reasons + chunk content-hashes. */
  contextPrimary: Array<{ id: string; reasons: string[]; chunkHashes: string[] }>;
}

/**
 * Compute all four ranking sections against the CURRENT retrieval/ranking code
 * paths using deterministic mock vectors. The provider's `embed` method is
 * temporarily replaced to return QUERY_VECTOR; the spy is restored after.
 *
 * @param root - Absolute path to a project built by {@link buildBaselineProject}.
 * @param store - The pre-populated v2 embedding store from {@link buildBaselineStore}.
 */
export async function computeRankingBaseline(
  root: string,
  store: EmbeddingStore,
): Promise<RankingBaseline> {
  setupProviderEnv();
  vi.spyOn(providerMod, "getProvider").mockReturnValue({
    embed: async () => QUERY_VECTOR,
    embedBatch: async (texts: string[]) => texts.map(() => QUERY_VECTOR),
  } as unknown as ReturnType<typeof providerMod.getProvider>);

  try {
    // A1: flip the on-disk v2 store to v3 via the REAL writer before capturing.
    // The fixture's chunk/page hashes are the live content hashes, so migration
    // preserves every vector (no re-embed, no provider embed call), and the v3
    // consumers (pickSearchSlugs / retrieveSemanticChunks) read the SAME vectors
    // — making the post-migration ranking equal the frozen golden.
    await updateEmbeddings(root, []);
    const sections = await captureAllSections(root, store);
    return sections;
  } finally {
    vi.restoreAllMocks();
    resetStaleEmbeddingWarnings();
    teardownProviderEnv();
  }
}

/** Set env vars so resolveEmbeddingModel() returns BASELINE_MODEL. */
function setupProviderEnv(): void {
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLMWIKI_EMBEDDING_MODEL = BASELINE_MODEL;
}

/** Remove env vars set by setupProviderEnv. */
function teardownProviderEnv(): void {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
}

/** Capture all four sections using the real retrieval/ranking functions. */
async function captureAllSections(root: string, store: EmbeddingStore): Promise<RankingBaseline> {
  const [snapshot, semantic] = await Promise.all([
    buildViewerSnapshot(root),
    retrieveSemanticChunks(root, BASELINE_QUERY, CHUNK_TOP_K),
  ]);

  const pageTopK = findTopK(QUERY_VECTOR, store, EMBEDDING_TOP_K).map((e) => ({
    slug: e.slug,
    score: round4(e.vector[0] / Math.sqrt(e.vector.reduce((s, v) => s + v * v, 0))),
  }));

  const chunkTopK = findTopKChunks(QUERY_VECTOR, store.chunks ?? [], CHUNK_TOP_K).map((r) => ({
    slug: r.chunk.slug,
    chunkIndex: r.chunk.chunkIndex,
    score: round4(r.score),
  }));

  const collapsedPageOrder = await pickSearchSlugs(root, BASELINE_QUERY);

  const contextPrimary = rankPages(snapshot, BASELINE_QUERY, CONTEXT_TOP_PAGES, semantic.hits)
    .map((p) => ({
      id: p.id,
      reasons: p.reasons,
      chunkHashes: p.chunks.map((c) => c.contentHash ?? ""),
    }));

  return { pageTopK, chunkTopK, collapsedPageOrder, contextPrimary };
}

/** Round a score to 4 decimal places for stable serialization. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Full orchestrator: build project files, persist the store, and compute
 * the baseline in one call.
 *
 * @param root - Absolute path to an empty directory (created by caller).
 */
export async function buildRankingBaseline(root: string): Promise<RankingBaseline> {
  const store = buildBaselineStore();
  await buildBaselineProject(root);
  await writeEmbeddingStore(root, store);
  return computeRankingBaseline(root, store);
}
