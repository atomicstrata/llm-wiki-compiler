/**
 * @file test/call-counter.ts
 * @description The test-file preload of the call counter (see `call-counting.ts`).
 * `scripts/test-profile.ts` adds it with `--preload`.
 *
 * Under `--parallel`, which `scripts/run-tests.mjs` always passes, Bun gives each
 * test file fresh globals, builtin modules and environment and re-runs the
 * preloads, so what is counted here is exactly one file's calls, recorded when
 * it finishes. Without `--parallel` the preload runs once for every file.
 * The CLI processes the file spawns count themselves through
 * `call-counter-child.ts`, which Bun preloads from `BUN_OPTIONS`, and record
 * under this file's name.
 */

import path from "node:path";
import { afterAll } from "bun:test";
import { installCallCounting, recordCallCounts } from "./call-counting.ts";

const file = path.relative(process.cwd(), process.argv[1] ?? "unknown");
const childPreload = `--preload=${path.join(import.meta.dir, "call-counter-child.ts")}`;
process.env.LLMWIKI_CALL_COUNTS_FILE = file;
if (!process.env.BUN_OPTIONS?.includes(childPreload)) {
  process.env.BUN_OPTIONS = [process.env.BUN_OPTIONS, childPreload].filter(Boolean).join(" ");
}

await installCallCounting("");
afterAll(() => recordCallCounts(file, "self"));
