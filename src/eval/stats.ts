/**
 * Corpus size stats collector for the llmwiki eval harness.
 *
 * Snapshots source count, page count, total wiki character count, and
 * embedding counts. Each run appends one JSON line to .llmwiki/eval/history.jsonl
 * for trend analysis over time.
 *
 * The three history READERS each have one body over {@link EvalFileReads}
 * (`loadHistoryFrom`, `loadPreviousReportFrom`, `loadLastFullReportFrom`); the
 * root-taking forms hand them the local disk's reads. The history WRITER has
 * one body too, `appendHistoryFrom`, over the raw writes. The SNAPSHOT has one
 * body, `collectStatsFrom`, over {@link StatsSources}: the three existing seams
 * its three reads already go through.
 */

import path from "path";
import { collectAllPagesFrom, diskLintPageSources, type LintPageSources } from "../linter/rules-shared.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { diskStoredEmbeddingReads, readStoredEmbeddingsFrom, type StoredEmbeddingReads } from "../utils/embeddings-storage.js";
import { listSelectedSourceFilesFrom } from "../sources/scan.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { diskEvalFileReads, type EvalFileReads } from "./file-reads.js";
import { diskEvalFileWrites, type EvalFileWrites } from "./file-writes.js";
import type { StatsResult, EvalReport } from "./types.js";

/** A v3-aware embedding snapshot for stats: counts plus an availability signal. */
interface EmbeddingSnapshot {
  available: boolean;
  entries: number;
  chunks: number;
}

/**
 * What the snapshot asks of the project: three existing seams, one per read.
 * It holds no count, page list, parsed store or availability verdict; each is
 * worked out in {@link collectStatsFrom} from what these return.
 */
export interface StatsSources {
  /** The source scan's reads: the source selection's configuration, then the sources directory's listings. */
  sourceReads: LegacyLocalReads;
  /** The page collection's sources, walked under the generic scope. */
  pages: LintPageSources;
  /** The stored-embedding reader's three raw facts of the private directory. */
  embeddings: StoredEmbeddingReads;
}

const HISTORY_DIR = path.join(".llmwiki", "eval");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.jsonl");

/**
 * Read a v3-aware embedding snapshot for stats. A missing, corrupt, or pre-v3
 * (outdated) store reports `available: false` — a DISTINCT degrade signal, never
 * silently `0`. A corpus-size snapshot must degrade, not crash.
 */
async function readEmbeddingSnapshot(reads: StoredEmbeddingReads): Promise<EmbeddingSnapshot> {
  let result: Awaited<ReturnType<typeof readStoredEmbeddingsFrom>>;
  try {
    const sharded = await reads.shardedCounts?.();
    if (sharded) return { available: true, entries: sharded.pages, chunks: sharded.chunks };
    result = await readStoredEmbeddingsFrom(reads);
  } catch {
    return { available: false, entries: 0, chunks: 0 };
  }
  if (result.kind !== "parsed" || result.parsed.version !== 3) return { available: false, entries: 0, chunks: 0 };
  const parsed = result.parsed;
  const entries = Array.isArray(parsed.store.entries) ? parsed.store.entries.length : 0;
  const chunks = Array.isArray(parsed.store.chunks) ? parsed.store.chunks.length : 0;
  return { available: true, entries, chunks };
}

/**
 * Collect a corpus size snapshot for the current project state.
 * @param root - Absolute path to the project root.
 */
export async function collectStats(root: string): Promise<StatsResult> {
  return collectStatsFrom({
    sourceReads: diskLocalReads(root), pages: diskLintPageSources(root), embeddings: diskStoredEmbeddingReads(root),
  });
}

/**
 * {@link collectStats} over {@link StatsSources}: THE ONE BODY. The three reads
 * are started together, in this order: the selected markdown sources, the
 * generic pages, the stored embeddings. A source or page failure rejects the
 * snapshot; an embedding failure of any kind degrades it and is never thrown.
 *
 * @param from - The source scan's reads, the page collection's sources and the stored-embedding reads.
 * @returns The counts, the page length figures, and the time the snapshot was put together.
 */
export async function collectStatsFrom(from: StatsSources): Promise<StatsResult> {
  const [sources, pages, embeddings] = await Promise.all([
    listSelectedSourceFilesFrom(from.sourceReads),
    collectAllPagesFrom(from.pages),
    readEmbeddingSnapshot(from.embeddings),
  ]);

  let totalWikiChars = 0;
  for (const { content } of pages) {
    const { body } = parseFrontmatter(content);
    totalWikiChars += body.length;
  }

  const pageCount = pages.length;
  const avgPageLengthChars = pageCount === 0 ? 0 : Math.round(totalWikiChars / pageCount);

  return {
    timestamp: new Date().toISOString(),
    sourceCount: sources.length,
    pageCount,
    totalWikiChars,
    embeddingCount: embeddings.entries,
    chunkEmbeddingCount: embeddings.chunks,
    avgPageLengthChars,
    // OMIT the key when available so healthy stats output is byte-unchanged.
    ...(embeddings.available ? {} : { embeddingsAvailable: false }),
  };
}

/**
 * Append the current eval report as a single JSON line to history.jsonl.
 * Creates the directory if it does not exist.
 * @param root - Absolute path to the project root.
 * @param report - The completed EvalReport to persist.
 */
export async function appendHistory(root: string, report: EvalReport): Promise<void> {
  return appendHistoryFrom(diskEvalFileWrites(root), report);
}

/**
 * {@link appendHistory} over the raw writes: THE ONE BODY. The directory is
 * made first; the report is serialized only after that succeeds; then one line
 * is appended. Any failure of the three rejects raw.
 *
 * @param writes - The directory make and the append.
 * @param report - The completed EvalReport to persist.
 */
export async function appendHistoryFrom(writes: EvalFileWrites, report: EvalReport): Promise<void> {
  await writes.makeDirectoryTree(HISTORY_DIR);
  await writes.appendText(HISTORY_FILE, JSON.stringify(report) + "\n");
}

/**
 * Load the last N eval reports from history.jsonl, oldest first.
 * Returns an empty array if no history file exists or the file is empty.
 * @param root - Absolute path to the project root.
 * @param n - Maximum number of reports to return (default 10).
 */
export async function loadHistory(root: string, n = 10): Promise<EvalReport[]> {
  return loadHistoryFrom(diskEvalFileReads(root), n);
}

/**
 * {@link loadHistory} over {@link EvalFileReads}: THE ONE BODY. `n` counts
 * LINES from the end, before malformed ones are skipped, and is handed to
 * `slice(-n)` as it is.
 *
 * @param reads - Whether the history file is there, and its whole text.
 * @param n - Maximum number of trailing lines to parse (default 10).
 */
export async function loadHistoryFrom(reads: EvalFileReads, n = 10): Promise<EvalReport[]> {
  if (!reads.existsSync(HISTORY_FILE)) return [];

  const content = await reads.readText(HISTORY_FILE);
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
async function readHistoryLines(reads: EvalFileReads): Promise<string[] | null> {
  if (!reads.existsSync(HISTORY_FILE)) return null;
  const content = await reads.readText(HISTORY_FILE);
  return content.trim().split("\n").filter(Boolean);
}

/**
 * Load the most recent eval report from history.jsonl, or null if none exists.
 * @param root - Absolute path to the project root.
 */
export async function loadPreviousReport(root: string): Promise<EvalReport | null> {
  return loadPreviousReportFrom(diskEvalFileReads(root));
}

/** {@link loadPreviousReport} over {@link EvalFileReads}: THE ONE BODY. A last line that does not parse answers null. */
export async function loadPreviousReportFrom(reads: EvalFileReads): Promise<EvalReport | null> {
  const lines = await readHistoryLines(reads);
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
  return loadLastFullReportFrom(diskEvalFileReads(root));
}

/** {@link loadLastFullReport} over {@link EvalFileReads}: THE ONE BODY. Searched from the last line back; a line that does not parse is passed over. */
export async function loadLastFullReportFrom(reads: EvalFileReads): Promise<EvalReport | null> {
  const lines = await readHistoryLines(reads);
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
