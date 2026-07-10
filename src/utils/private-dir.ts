/**
 * @file src/utils/private-dir.ts
 * @description Confined resolvers for the project's private `.llmwiki` directory.
 *
 * Two resolvers serve two distinct purposes:
 *
 * - {@link resolveConfinedPrivateDir} — the WRITE resolver. Used by lock
 *   acquisition, the journal, the event store seal, and the state/candidate
 *   writers. Confines and CREATES the dir (mkdir), then re-verifies the realpath
 *   after mkdir (TOCTOU). Callers that write files under `.llmwiki` use this.
 *
 * - {@link resolveExistingConfinedPrivateDir} — the READ resolver. Used by
 *   `loadProfile` and `readHeadAnchor`. Confines the target and checks for
 *   symlink-escape FAIL-CLOSED, but returns `null` rather than creating the dir
 *   when it does not yet exist. A clean project (no `.llmwiki`) must not have
 *   the directory created by a read-only surface (status, lint, exportJson, etc).
 *
 * Both share the same confinement primitive (`confineUnderRoot`) to avoid
 * duplicating the escape-check logic.
 *
 * The lock writer (`acquireLock`/`tryCreateLock`) and the page intent journal
 * (`openBatch`) both create files under `<root>/.llmwiki`. Without confinement a
 * planted `root/.llmwiki -> <out-of-tree>` symlink lets `mkdir(..,{recursive})`
 * follow the link and a lock/journal file land OUTSIDE the root. The write
 * resolver closes this via (1) lexical + ancestor confine, (2) mkdir, (3) TOCTOU
 * re-check of the post-mkdir realpath. The read resolver applies (1) + a TOCTOU
 * re-check after the lstat-based existence probe, but never runs (2).
 */

import { mkdir } from "fs/promises";
import { lstat } from "node:fs/promises";
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
 * Confine `<root>/.llmwiki` lexically + via ancestor check and return the
 * confined absolute path. Throws {@link PrivateDirConfinementError} on escape.
 * Shared by both resolvers so the confinement logic is never duplicated.
 */
async function confineLlmwikiDir(root: string): Promise<string> {
  try {
    return await confineUnderRoot(LLMWIKI_DIR, root, { mustExist: false });
  } catch (err) {
    throw new PrivateDirConfinementError((err as Error).message);
  }
}

/**
 * Post-existence TOCTOU re-check: verify that the realpath of an existing
 * `confined` dir still sits inside `realRoot`. A symlink swapped in between
 * the lstat/mkdir and this check would escape — fail closed.
 */
async function recheckRealpath(confined: string, realRoot: string): Promise<string> {
  const realDir = await safeRealpath(confined);
  if (realDir === null || !isInsideDir(realDir, realRoot)) {
    throw new PrivateDirConfinementError(`path escapes project root: ${LLMWIKI_DIR}`);
  }
  return realDir;
}

/**
 * Resolve `<root>/.llmwiki` to a confined absolute path, CREATING it, and FAIL
 * CLOSED (throw) if it — or any ancestor — is a symlink escaping the project root.
 *
 * The WRITE resolver: confines the target lexically + against the nearest
 * existing ancestor, makes the directory, then re-confines its post-`mkdir`
 * realpath (TOCTOU). The returned path is safe to create lock/journal files under.
 *
 * @param root - Absolute project root the private dir hangs off.
 * @returns The confined absolute realpath of `<root>/.llmwiki`.
 * @throws {PrivateDirConfinementError} When `.llmwiki` (or an ancestor) escapes the project root.
 */
export async function resolveConfinedPrivateDir(root: string): Promise<string> {
  const confined = await confineLlmwikiDir(root);
  await mkdir(confined, { recursive: true });
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  return recheckRealpath(confined, realRoot);
}

/**
 * Resolve `<root>/.llmwiki` to a confined absolute realpath WITHOUT creating it.
 *
 * The READ resolver: confines the target lexically + via ancestor escape-check
 * (FAIL CLOSED on escape — throws {@link PrivateDirConfinementError}), then checks
 * whether the dir actually EXISTS. Returns `null` when absent (caller treats this
 * as "no profile" / "no head anchor" — same as the prior absent behavior but
 * WITHOUT creating the directory). When the dir exists, re-verifies its realpath
 * sits inside the root (TOCTOU) before returning it.
 *
 * A malicious symlinked `.llmwiki` that escapes still FAILS CLOSED (throws) — it
 * is just not created. A read surface calling this on a clean project leaves the
 * filesystem unmodified.
 *
 * @param root - Absolute project root.
 * @returns The confined absolute realpath, or `null` when the dir is absent.
 * @throws {PrivateDirConfinementError} When `.llmwiki` (or an ancestor) escapes the project root.
 */
export async function resolveExistingConfinedPrivateDir(root: string): Promise<string | null> {
  const confined = await confineLlmwikiDir(root);
  try {
    await lstat(confined); // do NOT follow symlinks
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  return recheckRealpath(confined, realRoot);
}
