/**
 * Read-only project-state collector for `llmwiki next`.
 *
 * Inspects an llmwiki project root and reports counts, lint cache status,
 * and structural warnings without acquiring locks, mutating disk, or
 * running compile/lint. Designed to be cheap on small projects and to
 * stay cheap on large wikis by using directory mtimes as a stale-lint
 * proxy instead of stat-ing every page.
 *
 * Stale-lint detection is intentionally approximate per the spec:
 * directory-structure changes after the last lint run produce a
 * `lint-cache-stale` warning. Content-only edits may not trigger it on
 * every filesystem; exact lint freshness belongs to `llmwiki lint`.
 *
 * Candidate reads are race-tolerant: this collector delegates to
 * `countCandidates`, which skips malformed/partial candidate JSON the
 * same way `review list` does.
 */

import { stat, readdir, readFile } from "fs/promises";
import path from "path";
import {
  SOURCES_DIR,
  CONCEPTS_DIR,
  QUERIES_DIR,
  LLMWIKI_DIR,
  LAST_LINT_FILE,
  INDEX_FILE,
} from "../utils/constants.js";
import { countCandidates } from "../compiler/candidates.js";
import { LINT_CACHE_TIMESTAMP_PATTERN } from "../linter/cache.js";
import type { LintCacheEntry } from "../linter/cache.js";

/** Markdown extension treated as a wiki page for counting purposes. */
const MARKDOWN_EXT = ".md";

/** Warning codes the v1 collector may emit. Pinned by tests. */
type ProjectStateWarningCode =
  | "lint-cache-stale"
  | "lint-cache-unparseable"
  | "index-missing"
  | "sources-not-compiled"
  | "pending-candidates"
  | "project-unreadable";

/** One structural warning surfaced alongside the primary state. */
export interface ProjectStateWarning {
  code: ProjectStateWarningCode;
  message: string;
}

/** Three-state lint-cache shape per the JSON contract. */
interface LintCacheStatus {
  /** True when a cache file exists on disk, even if it failed to parse. */
  present: boolean;
  /** Parsed cache entry; null when no file exists OR file failed to parse. */
  entry: LintCacheEntry | null;
}

/** Full project-state snapshot consumed by `recommendNextAction` and renderers. */
export interface ProjectState {
  root: string;
  hasSourcesDir: boolean;
  hasWikiDir: boolean;
  hasInternalDir: boolean;
  sourceCount: number;
  conceptCount: number;
  queryCount: number;
  pendingCandidates: number;
  hasIndex: boolean;
  lint: LintCacheStatus;
  latestWikiMtimeMs: number | null;
  latestSourceMtimeMs: number | null;
  warnings: ProjectStateWarning[];
}

/**
 * Collect a full ProjectState snapshot for `root`. Never throws on
 * expected absent-file paths — those become `false`/`0`/`null` fields.
 * Returns a `project-unreadable` warning when the root itself cannot be
 * stat-ed; callers escalate that to the `broken-project` primary state.
 */
export async function collectProjectState(root: string): Promise<ProjectState> {
  const rootReadable = await isDirectory(root);
  if (!rootReadable) return brokenProjectState(root);
  const dirs = await collectDirPresence(root);
  const counts = await collectPageCounts(root, dirs);
  const lint = await collectLintCacheStatus(root);
  const mtimes = await collectMtimes(root, dirs);
  return assembleState({ root, dirs, counts, lint, mtimes });
}

/** State returned when `root` itself cannot be inspected. */
function brokenProjectState(root: string): ProjectState {
  return {
    root,
    hasSourcesDir: false,
    hasWikiDir: false,
    hasInternalDir: false,
    sourceCount: 0,
    conceptCount: 0,
    queryCount: 0,
    pendingCandidates: 0,
    hasIndex: false,
    lint: { present: false, entry: null },
    latestWikiMtimeMs: null,
    latestSourceMtimeMs: null,
    warnings: [
      {
        code: "project-unreadable",
        message: `Project root is unreadable or could not be inspected: ${root}`,
      },
    ],
  };
}

/** Cheap presence probes for the three structural directories the recommender keys on. */
interface DirPresence {
  hasSourcesDir: boolean;
  hasWikiDir: boolean;
  hasInternalDir: boolean;
}

/** Raw page counts surfaced into ProjectState; computed in one pass to keep collectProjectState short. */
interface PageCounts {
  sourceCount: number;
  conceptCount: number;
  queryCount: number;
  pendingCandidates: number;
  hasIndex: boolean;
}

/** Mtime proxies used for the cheap stale-lint approximation. */
interface MtimePair {
  latestWikiMtimeMs: number | null;
  latestSourceMtimeMs: number | null;
}

/** Probe the three structural directories without listing their contents. */
async function collectDirPresence(root: string): Promise<DirPresence> {
  const [hasSourcesDir, hasWikiDir, hasInternalDir] = await Promise.all([
    isDirectory(path.join(root, SOURCES_DIR)),
    isDirectory(path.join(root, "wiki")),
    isDirectory(path.join(root, LLMWIKI_DIR)),
  ]);
  return { hasSourcesDir, hasWikiDir, hasInternalDir };
}

/** Compute page counts plus the wiki/index.md presence flag. */
async function collectPageCounts(root: string, dirs: DirPresence): Promise<PageCounts> {
  const [sourceCount, conceptCount, queryCount, pendingCandidates, hasIndex] = await Promise.all([
    dirs.hasSourcesDir ? countMarkdownFiles(path.join(root, SOURCES_DIR)) : 0,
    dirs.hasWikiDir ? countMarkdownFiles(path.join(root, CONCEPTS_DIR)) : 0,
    dirs.hasWikiDir ? countMarkdownFiles(path.join(root, QUERIES_DIR)) : 0,
    dirs.hasInternalDir ? safeCountCandidates(root) : 0,
    dirs.hasWikiDir ? isFile(path.join(root, INDEX_FILE)) : false,
  ]);
  return { sourceCount, conceptCount, queryCount, pendingCandidates, hasIndex };
}

/** Read directory mtimes only when the directories exist; absent dirs report null. */
async function collectMtimes(root: string, dirs: DirPresence): Promise<MtimePair> {
  const [latestWikiMtimeMs, latestSourceMtimeMs] = await Promise.all([
    dirs.hasWikiDir ? safeMtime(path.join(root, "wiki")) : Promise.resolve(null),
    dirs.hasSourcesDir ? safeMtime(path.join(root, SOURCES_DIR)) : Promise.resolve(null),
  ]);
  return { latestWikiMtimeMs, latestSourceMtimeMs };
}

/** Read and validate the lint cache, distinguishing missing from corrupt. */
async function collectLintCacheStatus(root: string): Promise<LintCacheStatus> {
  const cachePath = path.join(root, LAST_LINT_FILE);
  const exists = await isFile(cachePath);
  if (!exists) return { present: false, entry: null };
  const entry = await readLintCacheEntry(cachePath);
  return { present: true, entry };
}

/** Strict parse + validate, returning null for any unreadable/corrupt cache file. */
async function readLintCacheEntry(cachePath: string): Promise<LintCacheEntry | null> {
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateCacheShape(parsed);
  } catch {
    return null;
  }
}

/** Mirror of the cache module's validator; kept local to avoid leaking internal helpers. */
function validateCacheShape(value: unknown): LintCacheEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { warnings, errors, at } = candidate;
  if (!isNonNegativeInteger(warnings)) return null;
  if (!isNonNegativeInteger(errors)) return null;
  if (typeof at !== "string" || !LINT_CACHE_TIMESTAMP_PATTERN.test(at)) return null;
  return { warnings, errors, at };
}

/** True for finite, non-negative integers. NaN and Infinity fail Number.isInteger. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Inputs to {@link assembleState}, grouped to keep the function's arity within limits. */
interface AssembleStateInput {
  root: string;
  dirs: DirPresence;
  counts: PageCounts;
  lint: LintCacheStatus;
  mtimes: MtimePair;
}

/** Combine the per-section reads into the final ProjectState + warning list. */
function assembleState(input: AssembleStateInput): ProjectState {
  const { root, dirs, counts, lint, mtimes } = input;
  const warnings = buildWarnings({ dirs, counts, lint, mtimes });
  return { root, ...dirs, ...counts, lint, ...mtimes, warnings };
}

/** Inputs for warning derivation; passed as a record to keep argument lists short. */
interface WarningInput {
  dirs: DirPresence;
  counts: PageCounts;
  lint: LintCacheStatus;
  mtimes: MtimePair;
}

/** Derive every structural warning from the already-collected state slices. */
function buildWarnings(input: WarningInput): ProjectStateWarning[] {
  const warnings: ProjectStateWarning[] = [];
  appendLintWarnings(warnings, input.lint, input.mtimes.latestWikiMtimeMs);
  appendStructuralWarnings(warnings, input.dirs, input.counts);
  return warnings;
}

/** Lint-cache warnings: unparseable file or stale-vs-wiki-mtime. */
function appendLintWarnings(
  warnings: ProjectStateWarning[],
  lint: LintCacheStatus,
  latestWikiMtimeMs: number | null,
): void {
  if (lint.present && lint.entry === null) {
    warnings.push({
      code: "lint-cache-unparseable",
      message: "Lint cache file exists but could not be parsed. Re-run `llmwiki lint`.",
    });
    return;
  }
  if (lint.entry && isLintCacheStale(lint.entry, latestWikiMtimeMs)) {
    warnings.push({
      code: "lint-cache-stale",
      message: "Lint cache is older than the wiki directory; pages were added or removed since the last lint.",
    });
  }
}

/** Structural warnings: missing index, pending candidates, uncompiled sources. */
function appendStructuralWarnings(
  warnings: ProjectStateWarning[],
  dirs: DirPresence,
  counts: PageCounts,
): void {
  const hasPages = counts.conceptCount > 0 || counts.queryCount > 0;
  if (hasPages && !counts.hasIndex) {
    warnings.push({
      code: "index-missing",
      message: "wiki/index.md is missing even though pages exist.",
    });
  }
  if (counts.pendingCandidates > 0) {
    warnings.push({
      code: "pending-candidates",
      message: `${counts.pendingCandidates} generated candidate${counts.pendingCandidates === 1 ? "" : "s"} waiting for review.`,
    });
  }
  if (dirs.hasSourcesDir && counts.sourceCount > 0 && !hasPages) {
    warnings.push({
      code: "sources-not-compiled",
      message: "Sources exist but no wiki pages were found. Run `llmwiki compile`.",
    });
  }
}

/** Cheap structural staleness: last-lint timestamp older than wiki dir mtime. */
function isLintCacheStale(entry: LintCacheEntry, latestWikiMtimeMs: number | null): boolean {
  if (latestWikiMtimeMs === null) return false;
  const lintMs = Date.parse(entry.at);
  if (Number.isNaN(lintMs)) return false;
  return latestWikiMtimeMs > lintMs;
}

/** True when `target` is a directory; false for missing paths or any other type. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    const stats = await stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/** True when `target` is a regular file; false for missing paths or directories. */
async function isFile(target: string): Promise<boolean> {
  try {
    const stats = await stat(target);
    return stats.isFile();
  } catch {
    return false;
  }
}

/** Directory mtime in ms epoch, or null when the directory cannot be stat-ed. */
async function safeMtime(target: string): Promise<number | null> {
  try {
    const stats = await stat(target);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

/** Count `.md` files in a directory; 0 for missing dirs or any other error. */
async function countMarkdownFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXT)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/** Race-tolerant candidate count; defers to `countCandidates` and swallows IO errors. */
async function safeCountCandidates(root: string): Promise<number> {
  try {
    return await countCandidates(root);
  } catch {
    return 0;
  }
}
