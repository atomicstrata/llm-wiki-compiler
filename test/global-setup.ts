/**
 * Vitest globalSetup: build dist/ once before any test file loads.
 *
 * Several test files spawn `node dist/cli.js` to exercise the CLI surface.
 * Without a shared setup, each file's own beforeAll would call tsup, and
 * vitest's parallel-by-default test workers would race on dist/cli.js
 * (tsup's `clean: true` wipes the file mid-write). Building once globally
 * eliminates the race and saves ~1s per integration test file.
 *
 * Invokes tsup's CLI with the Node binary ALREADY running this process, rather
 * than through `npx`. On Windows `npx` is `npx.cmd`, and since the Node 22
 * hardening for CVE-2024-27980 `child_process` no longer resolves `.cmd`/`.bat`
 * without `shell: true` — so `execFile("npx", …)` failed with ENOENT there,
 * aborting collection before a single test loaded. vitest then reported the
 * confusingly unrelated "No test files found", which points nowhere near the
 * cause. CI is Linux-only today, so nothing caught it.
 *
 * `shell: true` would also fix it, but re-opens the argument-quoting hole that
 * hardening closed. Resolving the CLI entry and running it directly needs no
 * shell at all and behaves identically on every platform.
 */

import { execFile } from "child_process";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { promisify } from "util";
import path from "path";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Absolute path to tsup's CLI entry, read from its `bin` field rather than
 * hardcoded, so a tsup release that moves the file cannot silently break this.
 */
function resolveTsupCli(): string {
  const manifestPath = require.resolve("tsup/package.json");
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const entry = typeof bin === "string" ? bin : bin.tsup;
  return path.join(path.dirname(manifestPath), entry);
}

export async function setup(): Promise<void> {
  await exec(process.execPath, [resolveTsupCli()], { cwd: path.resolve(".") });
}
