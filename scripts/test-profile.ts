/**
 * @file scripts/test-profile.ts
 * @description `bun run test:profile`: run tests and report what they cost in
 * filesystem calls and subprocess spawns, held to a committed baseline.
 *
 * Wall time on a shared machine moves with whatever else is running. A count
 * of calls does not, so a count is what a change can be held to. Each test
 * file's counts come from `test/call-counter.ts`; this script runs the suite
 * through `scripts/run-tests.mjs` with the counter on, prints a report, and
 * compares each file against `test-call-counts.json`.
 *
 *   bun run test:profile                       whole suite, check the baseline
 *   bun run test:profile test/foo.test.ts      some files, with each op counted
 *   bun run test:profile --sites test/foo.test.ts
 *                                              also name the src/ code making the calls
 *   bun run test:profile --update              rewrite the baseline from this run
 *
 * A file whose counts rise above its baseline fails the run. `--update` refuses
 * when any test failed, and a run over some files updates only those files.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareCallCounts, mergeByFile, readBaseline, summarize, type Baseline, type FileTotals } from "./test-profile-baseline.ts";
import type { FileCallCounts } from "../test/call-counting.ts";

const BASELINE_FILE = "test-call-counts.json";
const TOP_FILES = 15;
const TOP_SITES = 20;
const DETAIL_FILE_LIMIT = 3;

/** Run the selected tests with the counter on; return their exit code and each file's counts. */
function runCounted(files: readonly string[], sites: boolean): { exitCode: number; counts: FileCallCounts[] } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "llmwiki-call-counts-"));
  try {
    const env = { ...process.env, LLMWIKI_CALL_COUNTS: directory, ...(sites ? { LLMWIKI_CALL_SITES: "1" } : {}) };
    const run = spawnSync(process.execPath, ["scripts/run-tests.mjs", ...files], { stdio: "inherit", env });
    const counts = readdirSync(directory).flatMap((name) => readFileSync(path.join(directory, name), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as FileCallCounts));
    return { exitCode: run.status ?? 1, counts: mergeByFile(counts) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** `12,345` */
function n(value: number): string {
  return value.toLocaleString("en-US");
}

/** The heaviest operations of one file, heaviest first. */
function opsLine(ops: Record<string, number>, limit: number): string {
  return Object.entries(ops).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([op, count]) => `${op} ${n(count)}`).join(" · ");
}

/** `fs` and `spawn` added up over `items`. */
function sum(items: readonly FileTotals[]): FileTotals {
  return items.reduce((total, item) => ({ fs: total.fs + item.fs, spawn: total.spawn + item.spawn }), { fs: 0, spawn: 0 });
}

/** One line of totals, with the baseline's totals for the same files when there is one. */
function printTotals(totals: Record<string, FileTotals>, baseline: Baseline | null): void {
  const now = sum(Object.values(totals));
  const before = Object.keys(totals).flatMap((file) => baseline?.files[file] ?? []);
  const was = before.length ? ` (baseline ${n(sum(before).fs)} / ${n(sum(before).spawn)})` : "";
  console.log(`\nCalls: ${n(now.fs)} filesystem, ${n(now.spawn)} spawns across ${n(Object.keys(totals).length)} files${was}`);
}

/** Every op of each file, then its heaviest call sites when they were recorded. */
function printDetail(counts: readonly FileCallCounts[]): void {
  for (const item of counts) {
    console.log(`\n${item.file}\n  ${opsLine(item.ops, Infinity)}`);
    const sites = Object.entries(item.sites ?? {}).sort((a, b) => b[1] - a[1]).slice(0, TOP_SITES);
    for (const [site, count] of sites) console.log(`  ${n(count).padStart(8)}  ${site}`);
  }
}

/** Print totals, the heaviest files, and per-file detail for a small selection. */
function printReport(counts: readonly FileCallCounts[], totals: Record<string, FileTotals>, baseline: Baseline | null): void {
  printTotals(totals, baseline);
  console.log("Most filesystem calls:");
  for (const item of [...counts].sort((a, b) => totals[b.file]!.fs - totals[a.file]!.fs).slice(0, TOP_FILES)) {
    console.log(`  ${n(totals[item.file]!.fs).padStart(9)}  ${item.file}  (${opsLine(item.ops, 4)})`);
  }
  if (counts.length <= DETAIL_FILE_LIMIT) printDetail(counts);
}

/** Write the baseline: a whole-suite run replaces it, a partial run merges into it. */
function writeBaseline(totals: Record<string, FileTotals>, baseline: Baseline | null, partial: boolean): void {
  const kept = partial && baseline ? baseline.files : {};
  const files = Object.fromEntries(Object.entries({ ...kept, ...totals }).filter(([file]) => existsSync(file)).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ version: 1, files } satisfies Baseline, null, 2)}\n`);
  console.log(`Wrote ${BASELINE_FILE} (${n(Object.keys(files).length)} files).`);
}

/** Run, report, then update or check the baseline; the exit code is the result. */
function main(): number {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    update: { type: "boolean" }, sites: { type: "boolean" },
  } });
  const { exitCode, counts } = runCounted(positionals, values.sites === true);
  const totals = summarize(counts);
  const baseline = existsSync(BASELINE_FILE) ? readBaseline(readFileSync(BASELINE_FILE, "utf8")) : null;
  printReport(counts, totals, baseline);
  if (exitCode !== 0) {
    console.error("\nSome tests failed; their counts are not comparable and the baseline is unchanged.");
    return exitCode;
  }
  if (values.update) {
    writeBaseline(totals, baseline, positionals.length > 0);
    return 0;
  }
  return checkBaseline(totals, baseline);
}

/** Report each file against the baseline; fail when any file makes more calls. */
function checkBaseline(totals: Record<string, FileTotals>, baseline: Baseline | null): number {
  const { regressions, improved, unknown } = compareCallCounts(totals, baseline?.files ?? {});
  regressions.forEach((line) => console.error(`more calls than the baseline: ${line}`));
  console.log(`${n(improved)} files make fewer calls than the baseline (lower it with --update); ${n(unknown)} have none yet.`);
  return Math.sign(regressions.length);
}

process.exit(main());
