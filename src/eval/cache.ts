/**
 * Citation cache management for the llmwiki eval harness.
 *
 * The citation cache stores LLM judge results in .llmwiki/eval/citation-cache.jsonl
 * so subsequent `eval --suite full` runs skip already-judged (claim, span) pairs.
 * This module provides helpers to inspect and clear that cache independently of
 * running a full evaluation.
 */

import { unlink, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { CitationJudgement } from "./types.js";

const CACHE_FILE = path.join(".llmwiki", "eval", "citation-cache.jsonl");

export interface CacheSummary {
  total: number;
  fullySupported: number;
  partiallySupported: number;
  unsupported: number;
  byPage: Array<{ slug: string; count: number }>;
}

/**
 * Delete the citation cache file.
 * Returns true if the file existed and was deleted, false if it was already absent.
 * @param root - Absolute path to the project root.
 */
export async function clearCitationCache(root: string): Promise<boolean> {
  const cachePath = path.join(root, CACHE_FILE);
  if (!existsSync(cachePath)) return false;
  await unlink(cachePath);
  return true;
}

/**
 * Load all cached citation judgements as an array.
 * Returns an empty array if the cache file does not exist.
 * Malformed lines are silently skipped.
 * @param root - Absolute path to the project root.
 */
export async function loadCitationCache(root: string): Promise<CitationJudgement[]> {
  const cachePath = path.join(root, CACHE_FILE);
  if (!existsSync(cachePath)) return [];

  const content = await readFile(cachePath, "utf-8");
  const judgements: CitationJudgement[] = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try {
      judgements.push(JSON.parse(line) as CitationJudgement);
    } catch {
      // Skip malformed cache lines
    }
  }
  return judgements;
}

/**
 * Aggregate cached judgements into a summary with score distribution and per-page counts.
 * @param judgements - Array of citation judgements loaded from the cache.
 */
export function summarizeCitationCache(judgements: CitationJudgement[]): CacheSummary {
  let fullySupported = 0;
  let partiallySupported = 0;
  let unsupported = 0;
  const pageCounts = new Map<string, number>();

  for (const j of judgements) {
    if (j.score === 2) fullySupported++;
    else if (j.score === 1) partiallySupported++;
    else unsupported++;
    pageCounts.set(j.pageSlug, (pageCounts.get(j.pageSlug) ?? 0) + 1);
  }

  const byPage = [...pageCounts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count);

  return { total: judgements.length, fullySupported, partiallySupported, unsupported, byPage };
}
