/**
 * @file test/fixtures/guard-root.ts
 * @description Disposable roots that each hold an export-only guard module, for tests that
 * configure the child guard bootstrap with a real, loadable guard entry.
 *
 * Every `guardRoots` call owns its own list of created roots, so a caller's `cleanup` removes only
 * the roots that caller created; there is no shared pool across test files. The root name prefix
 * and the guard entry file name are the caller's, unchanged. Stubbing the bootstrap environment and
 * any runtime-specific composition stay in the calling test, which keeps its assertions visible.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** One created root: its path, the guard module's file URL, and the guard log path inside it. */
export interface GuardRoot {
  root: string;
  url: string;
  log: string;
}

/**
 * A per-caller factory of guard roots.
 * @param prefix - The `mkdtemp` prefix under the OS temporary directory.
 * @param entry - The file name of the export-only guard module written into each root.
 * @returns `create` makes one root with its guard module; `cleanup` removes every root this factory made.
 */
export function guardRoots(prefix: string, entry: string): {
  create: () => Promise<GuardRoot>;
  cleanup: () => Promise<void>;
} {
  const roots: string[] = [];
  return {
    create: async () => {
      const root = await mkdtemp(path.join(tmpdir(), prefix));
      roots.push(root);
      const guard = path.join(root, entry);
      await writeFile(guard, "export {};\n", "utf8");
      return { root, url: pathToFileURL(guard).href, log: path.join(root, "guard.jsonl") };
    },
    cleanup: async () => {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}
