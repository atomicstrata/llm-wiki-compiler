/**
 * Shared subprocess helpers for `llmwiki context` integration tests.
 *
 * `runContextJson()` spawns the compiled CLI with `--json`, asserts
 * exit 0, and returns the parsed envelope. Extracted so the same
 * idiom can be reused across `context-integration.test.ts` and the
 * Slice-4 provenance sibling without copy-pasting the runCLI +
 * expectCLIExit + JSON.parse boilerplate.
 *
 * `withSecretRoot()` wraps a test that needs a second tmp dir outside
 * the project root (escape-attempt fixtures for traversal/symlink
 * coverage) so the cleanup `rm` always runs, even on assertion
 * failure.
 */

import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./run-cli.js";

/** Run `llmwiki context <prompt> [extra...] --json` in `cwd`, return parsed JSON. */
export async function runContextJson(
  cwd: string,
  prompt: string,
  extra: string[] = [],
): Promise<Record<string, unknown>> {
  const result = await runCLI(["context", prompt, ...extra, "--json"], cwd);
  expectCLIExit(result, 0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/**
 * Allocate a temp dir, run `body(secretRoot)`, and clean up — even on
 * thrown assertions. Used by the Slice-4 escape tests that need to
 * stage a target file outside `sources/`.
 */
export async function withSecretRoot<T>(
  prefix: string,
  body: (secretRoot: string) => Promise<T>,
): Promise<T> {
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  try {
    return await body(secretRoot);
  } finally {
    await rm(secretRoot, { recursive: true, force: true });
  }
}
