/**
 * Page-level embedding: discover retrievable pages on disk, build their
 * embedding text, embed the changed/cold ones, and merge results into the
 * existing entry set. Phase 2 swaps the per-page loop for batched embedding.
 */

import { readdir } from "fs/promises";
import path from "path";
import { getProvider } from "./provider.js";
import { parseFrontmatter } from "./markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "./constants.js";
import { type EmbeddingEntry } from "./embeddings-store.js";
import { embedTextBatch, enrichEmbedError, makeCountingProvider } from "./embeddings-batch.js";
import { safeRealpath, isInsideDir } from "./path-confine.js";
import { readConfinedPage } from "./confined-read.js";
import type { PageRecord } from "../pages/read.js";

/** A reserved-namespace page record tagged with the directory it came from. */
export interface NamespacedPageRecord {
  /** `concepts` or `queries` — the reserved namespace of the source directory. */
  namespace: string;
  record: PageRecord;
}

/** Reserved namespaces and their on-disk directories, in priority order. */
const RESERVED_DIRS: ReadonlyArray<{ namespace: string; dir: string }> = [
  { namespace: path.basename(CONCEPTS_DIR), dir: CONCEPTS_DIR },
  { namespace: path.basename(QUERIES_DIR), dir: QUERIES_DIR },
];

/**
 * Scan concepts/ and queries/ directories, returning retrievable pages tagged
 * with the reserved namespace they came from.
 *
 * Each `.md` entry is realpath-confirmed to resolve INSIDE its canonical entity
 * directory and read through {@link readConfinedPage} (handle-bound), so a
 * symlinked page escaping the project tree is dropped before it is read — its
 * bytes never reach the embedding provider. A legit in-dir symlink (resolving
 * inside the dir) is still read.
 */
export async function collectNamespacedPageRecords(root: string): Promise<NamespacedPageRecord[]> {
  const records: NamespacedPageRecord[] = [];
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return records;
  for (const { namespace, dir } of RESERVED_DIRS) {
    const expectedDir = await safeRealpath(path.join(canonicalRoot, dir));
    if (!expectedDir || !isInsideDir(expectedDir, canonicalRoot)) continue;
    let files: string[];
    try {
      files = await readdir(expectedDir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      const record = await readConfinedPageRecord(expectedDir, file);
      if (record) records.push({ namespace, record });
    }
  }
  return records;
}

/** Scan concepts/ and queries/ for retrievable pages (untagged). */
export async function collectPageRecords(root: string): Promise<PageRecord[]> {
  return (await collectNamespacedPageRecords(root)).map((r) => r.record);
}

/**
 * Confine, read, and parse a single page into a PageRecord. The entry is dropped
 * (returns null) when its realpath escapes `expectedDir`, when the handle-bound
 * read fails closed, or when the page is an orphan / lacks a title.
 */
async function readConfinedPageRecord(expectedDir: string, file: string): Promise<PageRecord | null> {
  const resolved = await safeRealpath(path.join(expectedDir, file));
  if (!resolved || !isInsideDir(resolved, expectedDir)) return null;
  const content = await readConfinedPage(resolved, expectedDir);
  if (content === null) return null;
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
export function buildEmbeddingText(record: Pick<PageRecord, "title" | "summary">): string {
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
