/**
 * Shared deterministic environment and page fixtures for embedding refresh
 * integration tests. Only callers' provider spies intercept network requests;
 * the real refresh, retry markers, collection, and persistence remain active.
 */
import { writeFile } from "fs/promises";
import path from "path";
import { beforeEach, afterEach, vi } from "vitest";

/** Configure an isolated OpenAI embedding identity and restore the environment per test. */
export function useEmbeddingRefreshEnvironment(): void {
  beforeEach(() => {
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "on");
    vi.stubEnv("LLMWIKI_EMBED_STRICT", "off");
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "test-embed");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());
}

/** Seed or revise a real eligible page independently of its embedding cache. */
export async function writeEmbeddingTestPage(root: string, slug: string, revision = 1): Promise<void> {
  await writeFile(path.join(root, `wiki/concepts/${slug}.md`),
    `---\ntitle: ${slug}\nsummary: ${slug} summary ${revision}\n---\n\n${slug} body ${revision}.\n`);
}
