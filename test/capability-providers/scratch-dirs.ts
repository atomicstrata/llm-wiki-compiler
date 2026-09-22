/**
 * @file test/capability-providers/scratch-dirs.ts
 * @description Shared tracked temp-directory helper for runtime suites so each
 * test creates owner-private scratch roots and has them removed afterwards
 * without repeating the mkdtemp/realpath/cleanup scaffolding.
 */
import os from "node:os";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { afterEach } from "vitest";

/** Register cleanup and return a tracked scratch-directory factory. */
export function useScratchDirs() {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  return async (prefix: string): Promise<string> => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
    roots.push(root);
    return root;
  };
}
