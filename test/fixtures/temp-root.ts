/**
 * Shared test helper for creating temporary llmwiki project roots.
 * Used by tests that need a realistic filesystem layout (wiki/concepts, wiki/queries).
 *
 * Also exports `useTempRoot`, a composable that manages the full chdir lifecycle
 * (create → chdir in beforeEach, restore → rm in afterEach) so individual test
 * files don't duplicate this boilerplate.
 */

import { mkdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { beforeEach, afterEach, vi } from "bun:test";

/**
 * Create a temp directory simulating an llmwiki project root.
 * Creates wiki/concepts and wiki/queries subdirectories.
 * @param prefix - Short label for the temp directory name.
 * @returns Absolute path to the temporary root.
 */
export async function makeTempRoot(prefix: string): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `llmwiki-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  return root;
}

/** How many `useTempRoot` roots are entered, and the directory before the first. */
let activeRoots = 0;
let cwdBeforeRoots = "";

/**
 * State object populated by `useTempRoot`. Exposed as a mutable reference
 * so test files can read `ctx.dir` without calling a function.
 */
export interface TempRootCtx {
  /** Absolute path of the current test's temporary project root. */
  dir: string;
}

/**
 * Composable that registers beforeEach/afterEach hooks managing a temporary
 * project root. The current process directory is changed into the temp root
 * for each test and restored afterwards.
 *
 * Call at the top level of a describe block (or test file). Access the
 * current temp path via the returned context object's `dir` property.
 *
 * A file may call this more than once. Every instance restores the directory
 * recorded before the FIRST one entered, rather than the one it saw itself,
 * because Bun runs afterEach hooks in registration order: an instance restoring
 * "its" previous directory would chdir into a sibling root already removed.
 *
 * @param extraDirs - Additional sub-directories to create inside the root.
 * @returns Mutable context with the current `dir` set by each beforeEach.
 */
export function useTempRoot(extraDirs: string[] = []): TempRootCtx {
  const ctx: TempRootCtx = { dir: "" };

  beforeEach(async () => {
    ctx.dir = await makeTempRoot("test");
    for (const dir of extraDirs) {
      await mkdir(path.join(ctx.dir, dir), { recursive: true });
    }
    if (activeRoots === 0) cwdBeforeRoots = process.cwd();
    activeRoots += 1;
    process.chdir(ctx.dir);
  });

  afterEach(async () => {
    activeRoots -= 1;
    process.chdir(cwdBeforeRoots);
    await rm(ctx.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  return ctx;
}
