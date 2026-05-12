/**
 * Create a unique temporary directory OUTSIDE the temp-root used by
 * {@link makeTempRoot}. Symlink-escape regression tests need a target
 * that is provably not inside the project root; constructing it from
 * `os.tmpdir()` directly gives us that guarantee.
 */

import { mkdir } from "fs/promises";
import os from "os";
import path from "path";

/**
 * Make a directory at `os.tmpdir()/outside-<timestamp>-<rand>/` and
 * return its absolute path. Caller is responsible for cleanup if
 * needed; for vitest tests this is usually fine to leave behind since
 * each run uses a fresh suffix.
 */
export async function makeOutsideDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}
