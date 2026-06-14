/**
 * Shared test utilities for embedding store tests.
 */

import { mkdtemp, writeFile, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import type { EmbeddingEntry, EmbeddingStore } from "../../src/utils/embeddings.js";

export const STORE_PATH = ".llmwiki/embeddings.json";

export function makeEntry(slug: string, vector: number[]): EmbeddingEntry {
  return {
    slug,
    title: slug,
    summary: `Summary for ${slug}`,
    vector,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function makeStore(entries: EmbeddingEntry[], model = "test-model"): EmbeddingStore {
  return {
    version: 2,
    model,
    dimensions: entries[0]?.vector.length ?? 0,
    entries,
  };
}

export async function makeRoot(prefix = "llmwiki-test-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

export async function writeConceptPage(root: string, slug: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  const content = `---\ntitle: ${slug}\nsummary: Summary for ${slug}\n---\n\nBody`;
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), content);
}

export async function writeConcept(root: string, slug: string, body: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  const content = `---\ntitle: ${slug}\nsummary: Summary for ${slug}\n---\n\n${body}`;
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), content);
}
