/**
 * Corpus size stats collector for the llmwiki eval harness.
 *
 * Snapshots source count, page count, total wiki character count, and
 * embedding counts. Each run appends one JSON line to .llmwiki/eval/history.jsonl
 * for trend analysis over time.
 */

import { readdir, appendFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { readEmbeddingStore } from "../utils/embeddings.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { StatsResult, EvalReport } from "./types.js";

const HISTORY_DIR = path.join(".llmwiki", "eval");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.jsonl");

/** Count the number of files in a directory (non-recursive, ignores missing dir). */
async function countFiles(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith(".md")).length;
}

/**
 * Read the embedding store for a stats snapshot, treating a missing OR invalid
 * store as "no embeddings". `readEmbeddingStore` now validates the store and
 * throws on corruption; a corpus-size snapshot must degrade, not crash.
 */
async function safeReadEmbeddingStore(root: string) {
  try {
    return await readEmbeddingStore(root);
  } catch {
    return null;
  }
}

/**
 * Collect a corpus size snapshot for the current project state.
 * @param root - Absolute path to the project root.
 */
export async function collectStats(root: string): Promise<StatsResult> {
  const [sourceCount, pages, embeddingStore] = await Promise.all([
    countFiles(path.join(root, SOURCES_DIR)),
    collectAllPages(root),
    safeReadEmbeddingStore(root),
  ]);

  let totalWikiChars = 0;
  for (const { content } of pages) {
    const { body } = parseFrontmatter(content);
    totalWikiChars += body.length;
  }

  const pageCount = pages.length;
  const avgPageLengthChars = pageCount === 0 ? 0 : Math.round(totalWikiChars / pageCount);
  const embeddingCount = embeddingStore?.entries.length ?? 0;
  const chunkEmbeddingCount = embeddingStore?.chunks?.length ?? 0;

  return {
    timestamp: new Date().toISOString(),
    sourceCount,
    pageCount,
    totalWikiChars,
    embeddingCount,
    chunkEmbeddingCount,
    avgPageLengthChars,
  };
}

/**
 * Append the current eval report as a single JSON line to history.jsonl.
 * Creates the directory if it does not exist.
 * @param root - Absolute path to the project root.
 * @param report - The completed EvalReport to persist.
 */
export async function appendHistory(root: string, report: EvalReport): Promise<void> {
  const historyDir = path.join(root, HISTORY_DIR);
  await mkdir(historyDir, { recursive: true });
  await appendFile(path.join(root, HISTORY_FILE), JSON.stringify(report) + "\n");
}

/**
 * Load the last N eval reports from history.jsonl, oldest first.
 * Returns an empty array if no history file exists or the file is empty.
 * @param root - Absolute path to the project root.
 * @param n - Maximum number of reports to return (default 10).
 */
export async function loadHistory(root: string, n = 10): Promise<EvalReport[]> {
  const historyPath = path.join(root, HISTORY_FILE);
  if (!existsSync(historyPath)) return [];

  const content = await readFile(historyPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const reports: EvalReport[] = [];
  for (const line of lines.slice(-n)) {
    try {
      reports.push(JSON.parse(line) as EvalReport);
    } catch {
      // Skip malformed lines
    }
  }
  return reports;
}

/** Read the history file and return its non-empty lines, or null if it doesn't exist. */
async function readHistoryLines(root: string): Promise<string[] | null> {
  const historyPath = path.join(root, HISTORY_FILE);
  if (!existsSync(historyPath)) return null;
  const content = await readFile(historyPath, "utf-8");
  return content.trim().split("\n").filter(Boolean);
}

/**
 * Load the most recent eval report from history.jsonl, or null if none exists.
 * @param root - Absolute path to the project root.
 */
export async function loadPreviousReport(root: string): Promise<EvalReport | null> {
  const lines = await readHistoryLines(root);
  if (!lines || lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]) as EvalReport;
  } catch {
    return null;
  }
}

/**
 * Load the most recent full-suite eval report from history.jsonl, skipping fast-suite
 * entries. This ensures citation-support sampledHashes are not lost when a fast run
 * occurs between two full runs.
 * @param root - Absolute path to the project root.
 */
export async function loadLastFullReport(root: string): Promise<EvalReport | null> {
  const lines = await readHistoryLines(root);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const report = JSON.parse(lines[i]) as EvalReport;
      if (report.suite === "full") return report;
    } catch {
      // Skip malformed lines
    }
  }
  return null;
}
