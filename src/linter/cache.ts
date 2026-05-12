/**
 * Persistent cache of the most recent `llmwiki lint` run.
 *
 * Written by the lint command after a completed run, before any non-zero exit
 * for lint findings, so the cache always reflects the run the user just saw.
 * Crashed or partial runs leave the prior cache untouched.
 *
 * Consumers (e.g., the upcoming viewer's /api/health endpoint) read the cache
 * to surface lint counts without re-running lint per request. A missing or
 * malformed cache reads as null, which means "lint has not been run yet."
 */

import { mkdir, readFile } from "fs/promises";
import path from "path";
import { atomicWrite } from "../utils/markdown.js";
import { LLMWIKI_DIR, LAST_LINT_FILE } from "../utils/constants.js";
import type { LintSummary } from "./types.js";

/** One persisted lint summary. Shape is part of the public viewer-cache contract. */
export interface LintCacheEntry {
  warnings: number;
  errors: number;
  /** ISO-8601 timestamp of the run that produced these counts. */
  at: string;
}

/**
 * The exact ISO-8601 shape `writeLintCache` produces and `readLintCache` accepts.
 * Exported so tests can assert against the same regex the validator enforces and
 * never drift from the documented contract.
 */
export const LINT_CACHE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Persist a lint summary to `.llmwiki/last-lint.json` after a completed run.
 * Creates the `.llmwiki/` directory if missing. Overwrites any prior entry so
 * the cache reflects the most recent run, including zero-issue runs.
 */
export async function writeLintCache(root: string, summary: LintSummary): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  const entry: LintCacheEntry = {
    warnings: summary.warnings,
    errors: summary.errors,
    at: new Date().toISOString(),
  };
  await atomicWrite(path.join(root, LAST_LINT_FILE), `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Read the cached lint summary, returning null for missing or malformed files.
 * Validation is strict: every field must have its expected type, otherwise the
 * cache is treated as absent so callers do not surface garbage counts.
 */
export async function readLintCache(root: string): Promise<LintCacheEntry | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, LAST_LINT_FILE), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidEntry(parsed)) return null;
  return { warnings: parsed.warnings, errors: parsed.errors, at: parsed.at };
}

/** True for finite non-negative integers, including zero. NaN and Infinity fail Number.isInteger. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Strict type guard for the persisted cache entry.
 *
 * Counts must be finite non-negative integers (the writer only ever persists
 * `LintSummary` severity counts, which originate from a length on an array, so
 * anything else means the file was hand-edited or corrupted). The timestamp
 * must match the exact ISO-8601 shape the writer produces, otherwise downstream
 * consumers risk surfacing values like "2026-01-01" as full timestamps.
 */
function isValidEntry(value: unknown): value is LintCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(candidate.warnings) &&
    isNonNegativeInteger(candidate.errors) &&
    typeof candidate.at === "string" &&
    LINT_CACHE_TIMESTAMP_PATTERN.test(candidate.at)
  );
}
