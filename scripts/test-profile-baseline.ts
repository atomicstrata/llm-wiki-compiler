/**
 * @file scripts/test-profile-baseline.ts
 * @description The call-count baseline behind `bun run test:profile`: its
 * format, and the per-file comparison that holds a run to it.
 */

import type { FileCallCounts } from "../test/call-counting.ts";

/** One file's cost: filesystem calls, and subprocesses spawned. */
export interface FileTotals {
  fs: number;
  spawn: number;
}

/** `test-call-counts.json`. */
export interface Baseline {
  version: 1;
  files: Record<string, FileTotals>;
}

/**
 * How far a file may go above its baseline before it counts as a regression.
 * Two whole-suite runs gave identical counts for 1,612 of 1,628 files; most of
 * the rest moved by a handful of calls (lock retries), which is not a change in
 * cost.
 */
const ALLOWED_INCREASE = { fraction: 0.05, minimum: 10 };

/**
 * Files whose counts follow timing rather than code: they poll a subprocess or
 * race processes against each other, so how many calls happen depends on how
 * fast the machine is. Measured to move by up to 24% between identical runs.
 * They are counted and reported, never judged.
 */
const TIMING_DEPENDENT = new Set([
  "test/codex-agent-interrupt.test.ts",
  "test/provider-codex-agent.test.ts",
  "test/relation-store-concurrent.test.ts",
  "test/storage/project-lock-binding.test.ts",
]);

/** Whether one stored entry is a pair of whole counts. */
function isFileTotals(item: unknown): item is FileTotals {
  const totals = item as Partial<FileTotals> | null;
  return Number.isSafeInteger(totals?.fs) && Number.isSafeInteger(totals?.spawn);
}

/** Validate the stored format before treating any value as an allowance. */
export function readBaseline(text: string): Baseline {
  const value = JSON.parse(text) as Baseline;
  const entries = Object.values(Object(value.files) as Record<string, unknown>);
  if (value.version !== 1 || !entries.every(isFileTotals)) throw new Error("Invalid test-call-counts.json");
  return value;
}

/** Each file's totals, its own and its child processes': every op is a filesystem call except `spawn`. */
export function summarize(counts: readonly FileCallCounts[]): Record<string, FileTotals> {
  const totals: Record<string, FileTotals> = {};
  for (const { file, ops } of counts) {
    const spawn = ops.spawn ?? 0;
    const fs = Object.values(ops).reduce((sum, count) => sum + count, 0) - spawn;
    const total = (totals[file] ??= { fs: 0, spawn: 0 });
    total.fs += fs;
    total.spawn += spawn;
  }
  return totals;
}

/** One entry per file: its own and its child processes' ops and sites added together. */
export function mergeByFile(counts: readonly FileCallCounts[]): FileCallCounts[] {
  const merged = new Map<string, FileCallCounts>();
  const add = (into: Record<string, number>, from: Record<string, number> = {}) => {
    for (const [key, count] of Object.entries(from)) into[key] = (into[key] ?? 0) + count;
  };
  for (const item of counts) {
    const entry = merged.get(item.file) ?? { file: item.file, ops: {}, sites: {} };
    add(entry.ops, item.ops);
    add(entry.sites!, item.sites);
    merged.set(item.file, entry);
  }
  return [...merged.values()];
}

/** Whether `current` exceeds `allowed` by more than run-to-run noise. */
function exceeds(current: number, allowed: number): boolean {
  return current - allowed > Math.max(ALLOWED_INCREASE.minimum, allowed * ALLOWED_INCREASE.fraction);
}

/** How one file's counts compare with its baseline entry. */
function judge(file: string, now: FileTotals, was: FileTotals): string[] {
  if (TIMING_DEPENDENT.has(file)) return [];
  const regressions: string[] = [];
  if (exceeds(now.fs, was.fs)) regressions.push(`${file}: ${now.fs} filesystem calls, baseline ${was.fs}`);
  // A spawn starts a whole process: no allowance.
  if (now.spawn > was.spawn) regressions.push(`${file}: ${now.spawn} spawns, baseline ${was.spawn}`);
  return regressions;
}

/** Compare a run's files with their baseline. Files outside the run are not judged. */
export function compareCallCounts(
  current: Record<string, FileTotals>, baseline: Record<string, FileTotals>,
): { regressions: string[]; improved: number; unknown: number } {
  const measured = Object.entries(current).sort(([a], [b]) => a.localeCompare(b));
  const known = measured.filter(([file]) => baseline[file] !== undefined);
  return {
    regressions: known.flatMap(([file, now]) => judge(file, now, baseline[file]!)),
    improved: known.filter(([file, now]) => now.fs < baseline[file]!.fs || now.spawn < baseline[file]!.spawn).length,
    unknown: measured.length - known.length,
  };
}
