/**
 * @file src/utils/stream-digest.ts
 * @description The one streaming SHA-256 over an already-confinement-proven handle.
 * Lifecycle planning, lifecycle verification, and evidence capture all need the same
 * thing — hash a leaf without buffering it whole, and refuse rather than truncate past
 * the caller's ceiling — and a second copy of that loop is a second place for the
 * ceiling or the truncation behaviour to drift.
 */

import { createHash } from "node:crypto";
import type { openConfinedLeaf } from "./confined-read.js";

/** Chunk size for hashing a leaf without holding it in memory. */
const DIGEST_CHUNK_BYTES = 1024 * 1024;

type ConfirmedOpen = Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>;

/**
 * Hash a confirmed handle in bounded chunks. Returns null when the leaf exceeds
 * `maxBytes`, so an over-ceiling object is refused rather than silently truncated
 * into a digest that would match the wrong bytes.
 */
export async function streamConfinedDigest(
  opened: ConfirmedOpen, maxBytes: number, chunkBytes = DIGEST_CHUNK_BYTES,
): Promise<{ digest: string; total: number } | null> {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, opened.size)));
  let total = 0;
  for (;;) {
    const read = await opened.handle.read(scratch, 0, scratch.byteLength, total);
    if (read.bytesRead === 0) break;
    hash.update(scratch.subarray(0, read.bytesRead));
    total += read.bytesRead;
    if (total > maxBytes) return null;
  }
  return { digest: hash.digest("hex"), total };
}
