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
 */

import { afterEach } from "bun:test";

afterEach(() => {
  process.exitCode = 0;
});
