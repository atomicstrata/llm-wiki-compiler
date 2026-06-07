/**
 * Shared setup helpers for `llmwiki next` integration tests.
 *
 * Centralises the temp-dir lifecycle and the small per-test seeding
 * primitives so `next-integration.test.ts` and `freshness-next.test.ts`
 * don't duplicate the same boilerplate.
 */

import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { beforeEach, afterEach } from "vitest";
import { runCLI, expectCLIExit } from "./run-cli.js";

/** Mutable temp-dir state populated by {@link useNextTempDir}. */
export interface NextTempDirEnv {
  /** Absolute path to the isolated temp root; valid inside `it` blocks. */
  dir: string;
}

/**
 * Wire vitest before/afterEach hooks that create and clean up a temp directory.
 * Returns a live handle whose `dir` field refreshes before every test.
 * @param prefix - Short label for the temp directory name.
 */
export function useNextTempDir(prefix: string): NextTempDirEnv {
  const env: NextTempDirEnv = { dir: "" };
  beforeEach(async () => {
    env.dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  });
  afterEach(async () => {
    if (env.dir) await rm(env.dir, { recursive: true, force: true });
  });
  return env;
}

/**
 * Ensure `dir` exists and write a minimal markdown stub inside it.
 * Used to seed page counts without running the full compile pipeline.
 * @param dir - Directory to create and write into.
 * @param name - Filename for the markdown stub.
 */
export async function touchMarkdown(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), "# stub", "utf-8");
}

/**
 * Run `llmwiki next --json` in `dir`, assert exit 0, and return the
 * parsed payload. Assertion failure includes full subprocess diagnostics.
 * @param dir - Working directory for the subprocess.
 */
export async function runNextJson(dir: string): Promise<Record<string, unknown>> {
  const result = await runCLI(["next", "--json"], dir);
  expectCLIExit(result, 0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
