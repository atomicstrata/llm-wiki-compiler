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
 *
 * STORAGE. Each resolver has ONE body, `…From(io, root)`, over the raw probes of
 * {@link PrivateDirIo}; the exported root forms keep their signatures and pass
 * {@link diskPrivateDirIo}, whose members call the incumbent primitives at call
 * time, so module spies and mocks still intercept them. The bodies keep every
 * decision: the typed error, the `ENOENT`-means-absent rule, the realpath root
 * fallback and the post-existence re-check. The escape verdict of the lexical +
 * ancestor confine stays inside the shared `confineUnderRoot` primitive, reached
 * through the same `confineTarget` probe the page and journal contracts use.
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

/**
 * The RAW probes the two resolvers ask for. Each gives a physical answer only
 * and REJECTS raw (`safeRealPath` answers null instead); none is hosted,
 * access-controlled or durable, and none is in any package index.
 */
export interface PrivateDirIo {
  /**
   * `target` resolved under the realpath of `root`, lexically and against its
   * nearest existing ancestor, without requiring it to exist. REJECTS when it,
   * or a linked ancestor, escapes. Disk: `confineUnderRoot(target, root, { mustExist: false })`.
   */
  confineTarget(target: string, root: string): Promise<string>;
  /** `dir` and any missing parents. REJECTS raw. Disk: `mkdir(dir, { recursive: true })`. */
  makeDirectoryTree(dir: string): Promise<void>;
  /** `location` with every link resolved, or null on ANY failure. Disk: `safeRealpath(location)`, no options. */
  safeRealPath(location: string): Promise<string | null>;
  /** Resolves when ANYTHING is at `location`, a final link NOT followed; REJECTS raw, `ENOENT` included. Disk: `lstat(location)`. */
  probeEntryNoFollow(location: string): Promise<void>;
}

/** LOCAL DISK. The incumbent primitives, called at call time; no state, frozen. In no package index. */
export const diskPrivateDirIo: PrivateDirIo = Object.freeze({
  confineTarget: (target: string, root: string) => confineUnderRoot(target, root, { mustExist: false }),
  makeDirectoryTree: async (dir: string) => { await mkdir(dir, { recursive: true }); },
  safeRealPath: (location: string) => safeRealpath(location),
  probeEntryNoFollow: async (location: string) => { await lstat(location); },
});

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
async function confineLlmwikiDir(io: PrivateDirIo, root: string): Promise<string> {
  try {
    return await io.confineTarget(LLMWIKI_DIR, root);
  } catch (err) {
    throw new PrivateDirConfinementError((err as Error).message);
  }
}

/**
 * The root a confined `.llmwiki` was resolved under. `confineTarget` answers
 * `<realpath(root)>/.llmwiki` (or `<resolve(root)>/.llmwiki` when the root does
 * not resolve), and the name is one segment, so its parent IS the real root the
 * confinement judged against. Re-resolving the root for the re-check would ask
 * the filesystem again for the answer the confinement already used.
 */
function confinedRoot(confined: string): string {
  return path.dirname(confined);
}

/**
 * Post-existence TOCTOU re-check: verify that the realpath of an existing
 * `confined` dir still sits inside `realRoot`. A symlink swapped in between
 * the lstat/mkdir and this check would escape — fail closed.
 */
async function recheckRealpath(io: PrivateDirIo, confined: string, realRoot: string): Promise<string> {
  const realDir = await io.safeRealPath(confined);
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
  return resolveConfinedPrivateDirFrom(diskPrivateDirIo, root);
}

/** THE ONE BODY of {@link resolveConfinedPrivateDir}, over the raw probes it is handed. */
export async function resolveConfinedPrivateDirFrom(io: PrivateDirIo, root: string): Promise<string> {
  const confined = await confineLlmwikiDir(io, root);
  await io.makeDirectoryTree(confined);
  return recheckRealpath(io, confined, confinedRoot(confined));
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
  return resolveExistingConfinedPrivateDirFrom(diskPrivateDirIo, root);
}

/** THE ONE BODY of {@link resolveExistingConfinedPrivateDir}, over the raw probes it is handed. */
export async function resolveExistingConfinedPrivateDirFrom(io: PrivateDirIo, root: string): Promise<string | null> {
  const confined = await confineLlmwikiDir(io, root);
  try {
    await io.probeEntryNoFollow(confined); // do NOT follow symlinks
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return recheckRealpath(io, confined, confinedRoot(confined));
}
