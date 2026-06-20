/**
 * Page-level embedding: discover retrievable pages on disk, build their
 * embedding text, embed the changed/cold ones, and merge results into the
 * existing entry set. Phase 2 swaps the per-page loop for batched embedding.
 */

import { readdir } from "fs/promises";
import path from "path";
import { getProvider } from "./provider.js";
import { safeReadFile, parseFrontmatter } from "./markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "./constants.js";
import { type EmbeddingEntry } from "./embeddings-store.js";
import { embedTextBatch, enrichEmbedError, makeCountingProvider } from "./embeddings-batch.js";

/** A retrievable page record on disk (concepts/ or queries/). */
export interface PageRecord {
  slug: string;
  title: string;
  summary: string;
  body: string;
}

/** Scan concepts/ and queries/ directories, returning retrievable pages. */
export async function collectPageRecords(root: string): Promise<PageRecord[]> {
  const records: PageRecord[] = [];
  for (const dir of [CONCEPTS_DIR, QUERIES_DIR]) {
    const absDir = path.join(root, dir);
    let files: string[];
    try {
      files = await readdir(absDir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      const record = await readPageRecord(absDir, file);
      if (record) records.push(record);
    }
  }
  return records;
}

/** Parse a single page file into a PageRecord, skipping orphans/untitled pages. */
async function readPageRecord(absDir: string, file: string): Promise<PageRecord | null> {
  const content = await safeReadFile(path.join(absDir, file));
  const { meta, body } = parseFrontmatter(content);
  if (meta.orphaned || typeof meta.title !== "string") return null;
  return {
    slug: file.replace(/\.md$/, ""),
    title: meta.title,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    body,
  };
}

/** Build the text that represents a page in the embedding space. */
function buildEmbeddingText(record: PageRecord): string {
  return record.summary
    ? `${record.title}\n\n${record.summary}`
    : record.title;
}

/**
 * Embed every page in `records` whose slug is in `slugsToEmbed`, batched.
 * Vectors come back in input order, so zip them onto the selected records.
 */
export async function embedPages(
  records: PageRecord[],
  slugsToEmbed: Set<string>,
  batchSize: number,
  expectedDim?: number,
): Promise<{ entries: EmbeddingEntry[]; requests: number }> {
  const { provider, requestCount } = makeCountingProvider(getProvider());
  const now = new Date().toISOString();
  const selected = records.filter((r) => slugsToEmbed.has(r.slug));
  if (selected.length === 0) return { entries: [], requests: 0 };

  let vectors: number[][];
  try {
    vectors = await embedTextBatch(provider, selected.map(buildEmbeddingText), batchSize, expectedDim);
  } catch (err) {
    throw enrichEmbedError(err, "page", (i) => selected[i]?.slug);
  }
  const entries = selected.map((record, i) => ({
    slug: record.slug,
    title: record.title,
    summary: record.summary,
    vector: vectors[i],
    updatedAt: now,
  }));
  return { entries, requests: requestCount() };
}

/** Merge fresh embeddings into an existing store, dropping slugs not in liveSlugs. */
export function mergeEntries(
  existing: EmbeddingEntry[],
  fresh: EmbeddingEntry[],
  liveSlugs: Set<string>,
): EmbeddingEntry[] {
  const bySlug = new Map<string, EmbeddingEntry>();
  for (const entry of existing) {
    if (liveSlugs.has(entry.slug)) bySlug.set(entry.slug, entry);
  }
  for (const entry of fresh) {
    bySlug.set(entry.slug, entry);
  }
  return Array.from(bySlug.values());
}
