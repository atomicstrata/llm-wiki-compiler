/**
 * Shared helpers for embedding retry-state tests: run refreshes under the project
 * lock their production callers hold, capture both retry files byte-for-byte, and
 * refuse one marker's physical writes so the real writer reports success without
 * persisting (it swallows write and unlink failures, so callers must verify).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { vi } from "bun:test";
import { PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../../src/utils/constants.js";
import { refreshEmbeddingsDrainingPending } from "../../src/utils/embeddings-refresh.js";
import { acquireLockBlocking, releaseLock } from "../../src/utils/lock.js";
import * as markers from "../../src/utils/pending-embeddings.js";

/** Run a callback under the project lock. */
export async function withProjectLock(root: string, run: () => Promise<void>): Promise<void> {
  await acquireLockBlocking(root);
  try { await run(); } finally { await releaseLock(root); }
}

/** The shared compile/approve drain, under the lock. */
export function drainUnderLock(root: string, changed: string[] = []): Promise<void> {
  return withProjectLock(root, () => refreshEmbeddingsDrainingPending(root, changed));
}

/** Both retry files' raw bytes (null when absent), for byte-identity checks. */
export function retryFileBytes(root: string): Promise<(string | null)[]> {
  return Promise.all([PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE].map(file =>
    readFile(path.join(root, file), "utf8").catch(() => null)));
}

/** A physical marker write a test can refuse: the atomic replacement, or the unlink. */
export type MarkerOperation = "replace" | "remove";

/**
 * Make writes to one retry file report success without persisting anything, at
 * the PHYSICAL layer: the disk marker writes are wrapped so that a replacement
 * and/or an unlink of exactly `file` is refused with a plain error, which the
 * real writer swallows (no errno code, so no warning). Every other call, and
 * every other marker, is delegated to the real mechanism, so normalization, the
 * verifying re-read and settlement stay real.
 *
 * Scope: only storage built through the exported `diskEmbeddingMarkerWrites`
 * after this call, which is the retry lifecycle's root forms. The root writers
 * inside `pending-embeddings.ts` keep their module-local reference and stay real.
 * Install it before the refresh loads its retry. Returns the restore.
 */
export function swallowMarkerWrites(file: string, operations: readonly MarkerOperation[] = ["replace", "remove"]): () => void {
  const real = markers.diskEmbeddingMarkerWrites;
  // The marker constants are POSIX-relative; the real leaf is a native path, so compare native separators.
  const suffix = `${path.sep}${path.normalize(file)}`;
  const refuse = (operation: MarkerOperation, leaf: string): void => {
    if (operations.includes(operation) && leaf.endsWith(suffix)) throw new Error(`test refused ${operation} of ${file}`);
  };
  const spy = vi.spyOn(markers, "diskEmbeddingMarkerWrites").mockImplementation((root) => {
    const writes = real(root);
    return {
      ...writes,
      replaceLeaf: async (confineRoot, leaf, body) => { refuse("replace", leaf); await writes.replaceLeaf(confineRoot, leaf, body); },
      removeLeaf: async (leaf) => { refuse("remove", leaf); await writes.removeLeaf(leaf); },
    };
  });
  return () => spy.mockRestore();
}
