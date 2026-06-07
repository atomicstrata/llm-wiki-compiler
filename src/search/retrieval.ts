/**
 * Semantic and LLM-based page retrieval for llmwiki.
 *
 * Exports `pickSearchSlugs`, which resolves relevant page slugs for a
 * question by trying chunk-level retrieval first (highest precision), then
 * page-level embedding search, then LLM-driven selection over the wiki index.
 * Exports `loadPageRecords`, which hydrates a list of slugs into full
 * `PageRecord` objects, silently dropping missing or orphaned entries.
 *
 * This module is shared between the MCP tool layer and the in-process SDK.
 */

import path from "path";
import { findRelevantChunks, findRelevantPages } from "../utils/embeddings.js";
import { selectPages } from "../commands/query.js";
import { safeReadFile } from "../utils/markdown.js";
import { CHUNK_TOP_K, INDEX_FILE } from "../utils/constants.js";
import { readPageRecord, type PageRecord } from "../pages/read.js";

/** Deduplicate slugs while preserving the first-seen ordering. */
function dedupePreservingOrder(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * Resolve search candidates. Tries chunk-level retrieval first (highest
 * precision), then falls back to page-level embeddings, then to LLM-driven
 * selection over the wiki index.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param question - The query used to rank pages.
 * @returns Ordered list of relevant page slugs.
 */
export async function pickSearchSlugs(root: string, question: string): Promise<string[]> {
  try {
    const chunks = await findRelevantChunks(root, question, CHUNK_TOP_K);
    if (chunks.length > 0) return dedupePreservingOrder(chunks.map((c) => c.chunk.slug));
  } catch {
    // Chunk store unavailable — fall through to page-level embeddings.
  }

  try {
    const candidates = await findRelevantPages(root, question);
    if (candidates.length > 0) return candidates.map((c) => c.slug);
  } catch {
    // Embeddings unavailable — fall through to index-based selection.
  }

  const indexContent = await safeReadFile(path.join(root, INDEX_FILE));
  const { pages } = await selectPages(question, indexContent);
  return pages;
}

/**
 * Load full content for a list of slugs, skipping missing/orphaned pages.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param slugs - List of page slugs to hydrate.
 * @returns Populated page records for all found, non-orphaned pages.
 */
export async function loadPageRecords(root: string, slugs: string[]): Promise<PageRecord[]> {
  const records: PageRecord[] = [];
  for (const slug of slugs) {
    const page = await readPageRecord(root, slug);
    if (page) records.push(page);
  }
  return records;
}
