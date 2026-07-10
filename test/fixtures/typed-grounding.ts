/**
 * @file test/fixtures/typed-grounding.ts
 * @description Shared fixture for the F1 typed-query-grounding tests: build a
 * temp project with an `index.md`, a `papers` profile, seeded pages, and a
 * hand-built v3 embedding store keyed by qualified `pageId`. Both the
 * in-process `generateAnswer` tests and the MCP/SDK surface tests use this so
 * the store/profile/page scaffolding lives in exactly one place.
 */

import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { vi } from "vitest";
import { makeTempRoot } from "./temp-root.js";
import { writePage } from "./write-page.js";
import { writeProfileFile } from "./profile-fixtures.js";
import * as providerMod from "../../src/utils/provider.js";
import { resolveEmbeddingModel, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { hashChunkText, splitIntoChunks } from "../../src/utils/retrieval.js";
import { buildEmbeddingText } from "../../src/utils/embeddings-pages.js";
import type { ProfilePack } from "../../src/profile/types.js";

/**
 * Factory for a `vi.mock("../src/utils/llm.js", echoCallClaudeModule)` stub whose
 * `callClaude` ECHOES the answer-LLM user message (the grounding prompt) back as
 * the answer — letting a test assert which page bodies/metadata reached the LLM.
 * Shared so the several query-grounding test files declare the mock identically.
 */
export function echoCallClaudeModule(): { callClaude: ReturnType<typeof vi.fn> } {
  return { callClaude: vi.fn(async (opts: { messages: Array<{ content: string }> }) => opts.messages[0].content) };
}

/** Stub the active provider so a query embeds to `vec` (no network call). */
export function mockQueryVector(vec: number[]): void {
  const provider = { embed: async () => vec, embedBatch: async (t: string[]) => t.map(() => vec) };
  vi.spyOn(providerMod, "getProvider").mockReturnValue(provider as unknown as ReturnType<typeof providerMod.getProvider>);
}

/** A `papers` profile whose pages opt INTO both retrieval surfaces. */
export const PAPERS_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "papers-test",
  entities: { papers: { directory: "wiki/papers", retrieval: { includeInSearch: true, includeInContext: true } } },
};

/** A v3 chunk record for `pageId`'s chunk 0 over `body`, with vector `vec`. */
export function chunkOf(pageId: string, body: string, vec: number[]): EmbeddingStoreV3["chunks"][number] {
  return { pageId, title: pageId, chunkIndex: 0, contentHash: hashChunkText(splitIntoChunks(body)[0]), text: "cached", vector: vec, updatedAt: "t" };
}

/** Write a v3 store with the given chunks to `.llmwiki/embeddings.json`. */
export async function writeChunkStore(root: string, chunks: EmbeddingStoreV3["chunks"]): Promise<void> {
  const store: EmbeddingStoreV3 = { version: 3, model: resolveEmbeddingModel(), dimensions: 2, entries: [], chunks };
  await writeFile(path.join(root, ".llmwiki", "embeddings.json"), JSON.stringify(store));
}

/**
 * A v3 PAGE embedding record for `pageId`, with its `embeddingTextHash` computed
 * the SAME way the live registry does (over title+summary) so the read-time
 * freshness check passes. `title`/`summary` must match the seeded page's
 * frontmatter for the hit to survive the walk.
 */
export function pageEntryOf(
  pageId: string,
  title: string,
  summary: string,
  vec: number[],
): EmbeddingStoreV3["entries"][number] {
  return {
    pageId,
    title,
    summary,
    embeddingTextHash: hashChunkText(buildEmbeddingText({ title, summary })),
    vector: vec,
    updatedAt: "t",
  };
}

/** Write a v3 store carrying only PAGE entries (no chunks) — drives the page-level path. */
export async function writePageStore(root: string, entries: EmbeddingStoreV3["entries"]): Promise<void> {
  const store: EmbeddingStoreV3 = { version: 3, model: resolveEmbeddingModel(), dimensions: 2, entries, chunks: [] };
  await writeFile(path.join(root, ".llmwiki", "embeddings.json"), JSON.stringify(store));
}

/** Distinctive body for the typed `papers/foo` page in colliding-slug fixtures. */
export const PAPERS_BODY = "PAPERS_FOO_DISTINCTIVE_BODY about transformer scaling.";
/** Distinctive body for the concept `foo` page in colliding-slug fixtures. */
export const CONCEPT_BODY = "CONCEPT_FOO_DISTINCTIVE_BODY about a general idea.";

/**
 * Seed a project with a typed `papers/foo` and a colliding concept `foo`, plus a
 * v3 chunk store carrying a chunk for each (with the given query-aligned vectors).
 * Shared by the F1 grounding + PR4 provenance tests so the same-slug scaffolding
 * lives in one place.
 */
export async function buildCollidingProject(prefix: string, papersVec: number[], conceptVec: number[]): Promise<string> {
  const root = await seedTypedProject(prefix, "foo", PAPERS_BODY);
  await writePage(path.join(root, "wiki/concepts"), "foo", { title: "Concept Foo", summary: "cs" }, CONCEPT_BODY);
  await writeChunkStore(root, [chunkOf("papers/foo", PAPERS_BODY, papersVec), chunkOf("concepts/foo", CONCEPT_BODY, conceptVec)]);
  return root;
}

/** Seed a project root: `index.md`, the `papers` profile, and one typed page. */
export async function seedTypedProject(prefix: string, slug: string, body: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  await writeProfileFile(root, PAPERS_PROFILE);
  await mkdir(path.join(root, "wiki/papers"), { recursive: true });
  await writePage(path.join(root, "wiki/papers"), slug, { title: slug, summary: "s" }, body);
  return root;
}
