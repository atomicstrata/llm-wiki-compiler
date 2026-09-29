/**
 * Shared helpers for embedding retry-state tests: run refreshes under the project
 * lock their production callers hold, capture both retry files byte-for-byte, and
 * simulate a marker writer that reports success without persisting (the real
 * writer swallows write and unlink failures, so callers must verify).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
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

/** Make writes to one retry file report success without persisting anything. */
export function swallowMarkerWrites(file: string): void {
  const write = markers.writePendingEmbeddings;
  vi.spyOn(markers, "writePendingEmbeddings").mockImplementation(async (root, entries, target = PENDING_EMBEDDINGS_FILE) =>
    target === file ? undefined : write(root, entries, target));
}
