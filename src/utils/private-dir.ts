/**
 * @file src/utils/private-dir.ts
 * @description Confined resolver for the project's private `.llmwiki` directory —
 * the single primitive every writer under `.llmwiki/` uses to fail CLOSED when
 * that directory (or an ancestor of it) is a symlink escaping the project root.
 *
 * The lock writer (`acquireLock`/`tryCreateLock`) and the page intent journal
 * (`openBatch`) both create files under `<root>/.llmwiki`. Without confinement a
 * planted `root/.llmwiki -> <out-of-tree>` symlink lets `mkdir(..,{recursive})`
 * follow the link and a lock/journal file land OUTSIDE the root. This resolver
 * (1) confines `<root>/.llmwiki` under `realpath(root)` via {@link confineUnderRoot}
 * (which rejects an existing symlinked dir/ancestor that escapes), (2) creates the
 * confined directory, and (3) RE-checks after the mkdir that the realpath of the
 * created directory still sits inside the root's realpath — closing the TOCTOU
 * window where the link is swapped in between the lexical check and the mkdir. A
 * normal real `.llmwiki` resolves to itself, so the happy path is unchanged.
 */

import { mkdir } from "fs/promises";
import path from "path";
import { LLMWIKI_DIR } from "./constants.js";
import { confineUnderRoot, safeRealpath, isInsideDir } from "./path-confine.js";

/**
 * Raised when the private `.llmwiki` dir (or an ancestor) is a symlink that
 * escapes the project root — the private-dir confinement failure. A TYPED error
 * (not a generic `Error`) so event read surfaces can CATCH it and map it to a
 * fail-closed finding instead of crashing. Mirrors the shape of
 * `GraphDirConfinementError` in `jsonl-store.ts`.
 */
export class PrivateDirConfinementError extends Error {
  constructor(message: string) {
    super(`private dir rejected: ${message}`);
    this.name = "PrivateDirConfinementError";
  }
}

// `confineUnderRoot` resolves its target via `path.resolve(realpath(root), target)`,
// so the target is passed RELATIVE to root (not as an absolute path built from the
// pre-realpath root) — an absolute `<unrealpath-root>/.llmwiki` would be judged
// outside the realpath'd root on platforms where root is itself a symlink (macOS
// `/var` → `/private/var`) and spuriously rejected.

/**
 * Resolve `<root>/.llmwiki` to a confined absolute path, CREATING it, and FAIL
 * CLOSED (throw) if it — or any ancestor — is a symlink escaping the project root.
 *
 * Mirrors the journal's `resolveConfinedJournalDir` confinement, but for the
 * private-dir WRITE path: it confines the target lexically + against the nearest
 * existing ancestor, makes the directory, then re-confines its post-`mkdir`
 * realpath (TOCTOU). The returned path is safe to create lock/journal files under.
 *
 * @param root - Absolute project root the private dir hangs off.
 * @returns The confined absolute path of `<root>/.llmwiki`.
 * @throws When `.llmwiki` (or an ancestor) escapes the project root.
 */
export async function resolveConfinedPrivateDir(root: string): Promise<string> {
  let confined: string;
  try {
    confined = await confineUnderRoot(LLMWIKI_DIR, root, { mustExist: false });
  } catch (err) {
    throw new PrivateDirConfinementError((err as Error).message);
  }
  await mkdir(confined, { recursive: true });
  const realDir = await safeRealpath(confined);
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  if (realDir === null || !isInsideDir(realDir, realRoot)) {
    throw new PrivateDirConfinementError(`path escapes project root: ${LLMWIKI_DIR}`);
  }
  return realDir;
}
