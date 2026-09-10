/** Command entry for the public test type-check ratchet. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import ts from "typescript";
import { collectTestDiagnostics } from "./test-typecheck-program.ts";
import { compareDiagnosticCounts } from "./test-typecheck-ratchet.ts";

const BASELINE_FILE = "test-typecheck-baseline.json";

interface Baseline {
  version: 1;
  typescript: string;
  configuration: string;
  counts: Record<string, number>;
}

/** Validate the stored format before treating any value as an allowance. */
function parseBaseline(text: string): Baseline {
  const value = JSON.parse(text) as Partial<Baseline> | null;
  if (!value || value.version !== 1 || typeof value.typescript !== "string" ||
      typeof value.configuration !== "string" || !value.counts ||
      typeof value.counts !== "object" || Array.isArray(value.counts) ||
      !Object.values(value.counts).every((count) => Number.isSafeInteger(count) && count > 0)) {
    throw new Error("Invalid test type-check baseline");
  }
  return value as Baseline;
}

/** Read a baseline at a resolved commit; absence is allowed only for first introduction. */
function baselineAt(ref: string): Baseline | null {
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!git(["ls-tree", "--name-only", commit, "--", BASELINE_FILE])) return null;
  return parseBaseline(git(["show", `${commit}:${BASELINE_FILE}`]));
}

/** Keep comparison failures readable without a process stack trace. */
function requireNoErrors(errors: string[]): void {
  if (errors.length) throw new Error(errors.join("\n"));
}

/** Parse the small CLI surface and keep bootstrap separate from routine reductions. */
function readOptions() {
  const { values } = parseArgs({ options: {
    init: { type: "boolean" }, update: { type: "boolean" }, "base-ref": { type: "string" },
  } });
  if (values.init && values.update) throw new Error("Choose --init or --update, not both");
  if (values.init && existsSync(BASELINE_FILE)) throw new Error("Baseline already exists; use --update for reductions");
  return values;
}

/** A metadata change requires explicit migration, not an automatic allowance update. */
function readCompatibleBaseline(current: Baseline, initialize: boolean): Baseline {
  const stored = initialize ? current : parseBaseline(readFileSync(BASELINE_FILE, "utf8"));
  if (stored.typescript !== current.typescript || stored.configuration !== current.configuration) {
    throw new Error("TypeScript version or test configuration changed; review and regenerate the baseline explicitly");
  }
  return stored;
}

/** Prevent a PR from editing its baseline upward to conceal a new diagnostic. */
function checkPriorBaseline(stored: Baseline, ref: string | undefined): void {
  if (!ref) return;
  const prior = baselineAt(ref);
  if (prior) requireNoErrors(compareDiagnosticCounts(stored.counts, prior.counts, true));
}

/** Compare current diagnostics, update only downward, and optionally enforce the PR-base ratchet. */
function main(): void {
  const values = readOptions();
  const snapshot = collectTestDiagnostics(process.cwd());
  const current: Baseline = { version: 1, typescript: ts.version, configuration: snapshot.configuration, counts: snapshot.counts };
  const stored = readCompatibleBaseline(current, values.init === true);
  checkPriorBaseline(stored, values["base-ref"]);
  requireNoErrors(compareDiagnosticCounts(current.counts, stored.counts, values.update === true));
  if (values.init || values.update) writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + "\n");
  const total = Object.values(current.counts).reduce((sum, count) => sum + count, 0);
  console.log(`Test type-check: ${snapshot.checkedFiles.length} files checked; ${total} baseline diagnostics in ${Object.keys(current.counts).length} files; no regression.`);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
