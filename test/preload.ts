/**
 * @file test/preload.ts
 * @description Suite-wide hooks, preloaded by bunfig.toml for every test file.
 *
 * Commands under test report failure through `process.exitCode`, and suites
 * assert on it. Under vitest each test file ran in a worker, so whatever code a
 * command left behind never reached the runner's own exit status. Bun runs the
 * test file in the same process, so a leftover `1` fails the whole run even
 * when every assertion passed, and `process.exitCode = undefined` (the usual
 * restore) is ignored. Resetting after each test keeps a command's exit code a
 * value the test observes, not a verdict on the run.
 *
 * With LLMWIKI_TEST_TRACE set to a directory, each test start is appended to a
 * per-process file there, so CI can name the file a hung worker was running.
 */

import { appendFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach } from "bun:test";

const traceDir = process.env.LLMWIKI_TEST_TRACE;
if (traceDir) {
  const trace = path.join(traceDir, `${process.pid}.log`);
  beforeEach(() => appendFileSync(trace, `${new Date().toISOString()} ${Bun.main}\n`));
}

afterEach(() => {
  process.exitCode = 0;
});
