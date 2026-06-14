/**
 * Shared throwaway-temp-dir lifecycle for the OKF reader tests.
 *
 * Those tests build an ad-hoc bundle layout under a plain temp directory (no
 * project root, no chdir) and assert against bundle-relative paths, so they
 * can't use `useTempRoot` (which provisions wiki/ subdirs and chdirs). This
 * composable just creates a unique temp dir per test and removes it after,
 * exposing the path via a mutable context.
 */

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach } from "vitest";

/** Mutable holder for the current test's temp dir path. */
export interface OkfTempDirCtx {
  /** Absolute path of the temp dir, or "" before the first `make()` call. */
  dir: string;
}

/**
 * Register an afterEach that removes whatever directory the returned `make`
 * last created. Call `make(prefix)` inside each test to get a fresh temp dir.
 *
 * @returns A context object plus a `make` factory for per-test temp dirs.
 */
export function useOkfTempDir(): { ctx: OkfTempDirCtx; make: (prefix: string) => Promise<string> } {
  const ctx: OkfTempDirCtx = { dir: "" };
  afterEach(async () => {
    if (ctx.dir) await rm(ctx.dir, { recursive: true, force: true });
    ctx.dir = "";
  });
  const make = async (prefix: string): Promise<string> => {
    ctx.dir = await mkdtemp(path.join(tmpdir(), prefix));
    return ctx.dir;
  };
  return { ctx, make };
}
