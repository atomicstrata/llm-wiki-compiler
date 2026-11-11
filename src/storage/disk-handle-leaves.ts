/**
 * @file src/storage/disk-handle-leaves.ts
 * @description Reads of ONE LEAF on the local disk that keep a file handle open
 * across more than one step and NEVER HAND IT OUT. Each function opens, does
 * its several handle calls, closes, and returns a plain value. The legacy
 * profile loader and the product-package member check are the callers, and
 * these bodies are what those modules did inline with a handle of their own.
 * The member check has a second form, {@link readConfinedLeafDigest}, that
 * also returns the bytes it hashed, so a caller that needs a member's content
 * does not open and hash the same leaf again: the SAME body, the same
 * classification, with the streamed bytes kept.
 *
 * This is a LOCAL PHYSICAL IMPLEMENTATION BOUNDARY, like the other
 * `storage/disk-*` files: one implementation, nothing injected, no port. No
 * `FileHandle` and no opened-leaf value appears in an exported signature. A
 * registered or hosted project uses `ProjectStore`; none of this is a step
 * toward hosting these files.
 *
 * WHAT THESE DO NOT KNOW. Neither knows what a profile, a product, a package
 * or a member is. They raise no domain error, choose no message, decode no
 * format and parse nothing. Each reports what happened and its caller decides
 * what that means.
 *
 * THE TWO ARE DIFFERENT ON PURPOSE and must not be merged with each other or
 * with the reads in `disk-private-leaves.ts`, which they resemble. They differ
 * from those, and from each other, in what a failed open means, whether a
 * failed `stat` or read rejects, whether an over-size leaf reports its size,
 * and what a failing `close` does:
 *
 *  - {@link readLeafTextNoFollowCapped} checks the LEAF ONLY and confines
 *    nothing. It keeps a failed OPEN apart (as a value carrying the raw
 *    error), reports an over-cap leaf WITH its size, and REJECTS for a failed
 *    `stat`, a failed read, or a failing `close`.
 *  - {@link checkConfinedLeafDigest} carries the existing confined open's
 *    guard and never rejects once that open has returned: every failure after
 *    a confirmed open is `"differs"`, and a failing `close` is ignored.
 *    {@link readConfinedLeafDigest} is that one body with the bytes kept: its
 *    classification is identical outcome for outcome, and its bytes are
 *    returned ONLY with `matches`, so no unverified byte ever leaves.
 *
 * Nothing here is newly confined, atomic or durable; each keeps exactly the
 * behaviour of the caller it came from.
 */

import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { openConfinedLeaf, type ConfirmedLeafOpen, type ReadLeafOptions } from "../utils/confined-read.js";
import { openFileNoFollow, readOpenedTextWithinCap } from "../utils/no-follow-open.js";
import { streamConfinedDigest } from "../utils/stream-digest.js";

/** What one capped no-follow text read found, kept apart so the caller can decide: the open failed, the leaf is over the cap, or its text. */
export type CappedTextNoFollowRead =
  | { kind: "not-opened"; error: unknown }
  | { kind: "oversize"; size: number }
  | { kind: "text"; text: string };

/**
 * LEAF-ONLY CHECK, NOT CONFINED. Open `leaf` without following a link
 * (`O_RDONLY | O_NOFOLLOW`, flags read when called), take its size from the
 * open handle, and read it as text only when that size is within `maxBytes`.
 *
 * A failed OPEN is the value `not-opened` carrying the raw error untouched
 * (absent, a link, a refused non-regular leaf, a permission error: the caller
 * tells them apart). A leaf over the cap is `oversize` with its size, and is
 * NEVER read. Otherwise the content, decoded by Node's own lenient `"utf-8"`
 * read: invalid bytes become replacement characters, they are not refused.
 *
 * A failed `stat` or a failed read REJECTS with the raw error. `close` runs
 * in `finally`, exactly once after a successful open, and a failing `close`
 * rejects too, replacing an `oversize` or `text` result that was ready. Those
 * post-open steps are {@link readOpenedTextWithinCap}, which the event head
 * read also runs after its OWN, different open; only that tail is shared.
 */
export async function readLeafTextNoFollowCapped(leaf: string, maxBytes: number): Promise<CappedTextNoFollowRead> {
  let handle: FileHandle;
  try {
    handle = await openFileNoFollow(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return { kind: "not-opened", error };
  }
  return readOpenedTextWithinCap(handle, maxBytes);
}

/** What one confined leaf is, against the bytes its caller expects. */
export type ConfinedLeafDigestCheck = "absent" | "unavailable" | "matches" | "differs";

/** {@link ConfinedLeafDigestCheck} with the verified bytes on `matches`, and only there. */
export type ConfinedLeafDigestRead =
  | { kind: Exclude<ConfinedLeafDigestCheck, "matches"> }
  | { kind: "matches"; bytes: Buffer };

/** The bytes a leaf is expected to hold: a lowercase hex SHA-256 and an exact byte count. */
interface ExpectedLeafBytes { sha256Hex: string; byteCount: number }

/**
 * CARRIES THE CONFINED OPEN'S GUARD. `openConfinedLeaf(root, leaf,
 * expectedDir, opts)` exactly, with `opts` passed through unchanged (the
 * production `requireSingleLink` included): anything short of a confirmed open
 * is returned as that open's own `absent` or `unavailable`. `expected` is the
 * bytes the caller expects: a lowercase hex SHA-256 and an exact byte count.
 *
 * On a confirmed open the leaf is hashed BY STREAM, never buffered whole. Its
 * size is compared to `expected.byteCount` BEFORE any byte is read; the stream
 * is capped at that count; and the handle is `stat`ed again afterwards and
 * must still be the same file (device, inode, link count, size). `matches`
 * only when all of that holds and the digest equals `expected.sha256Hex`.
 *
 * NEVER REJECTS after the open has returned: any other outcome, a thrown
 * `stat` or read included, is `differs`. The handle is closed once on every
 * path after a confirmed open, and a failing `close` is ignored.
 */
export async function checkConfinedLeafDigest(
  root: string, leaf: string, expectedDir: string, expected: ExpectedLeafBytes, opts: ReadLeafOptions = {},
): Promise<ConfinedLeafDigestCheck> {
  return (await digestConfinedLeaf(root, leaf, expectedDir, expected, opts, false)).kind;
}

/**
 * {@link checkConfinedLeafDigest} that KEEPS THE BYTES IT HASHED. The same
 * open, the same size check before any read, the same capped stream, the same
 * post-read `stat`, the same digest comparison and the same never-reject rule:
 * every outcome is classified exactly as the check classifies it. The streamed
 * chunks are copied into one buffer of exactly `expected.byteCount` bytes as
 * they are hashed, and that buffer is returned only with `matches`, so the
 * bytes handed out are the bytes the digest was taken over.
 *
 * The caller bounds the memory: the buffer is `expected.byteCount` long, and
 * that count is allocated only after the open has confirmed the leaf is that
 * size. A caller that must not hold a large leaf uses the check instead.
 */
export async function readConfinedLeafDigest(
  root: string, leaf: string, expectedDir: string, expected: ExpectedLeafBytes, opts: ReadLeafOptions = {},
): Promise<ConfinedLeafDigestRead> {
  const { kind, bytes } = await digestConfinedLeaf(root, leaf, expectedDir, expected, opts, true);
  if (kind !== "matches") return { kind };
  // Kept bytes always accompany `matches` here; a missing buffer fails closed rather than passing unverified.
  return bytes === null ? { kind: "differs" } : { kind, bytes };
}

/** One digest outcome: the classification, and the kept bytes with `matches` when they were asked for. */
type DigestOutcome = { kind: ConfinedLeafDigestCheck; bytes: Buffer | null };

/** The outcome for every failure after a confirmed open. */
const DIFFERS: DigestOutcome = { kind: "differs", bytes: null };

/**
 * THE ONE BODY of the check and the read: the confined open, then
 * {@link digestOpenedLeaf} over it, never rejecting once the open has returned,
 * and closing the handle once on every path (a failing `close` is ignored).
 */
async function digestConfinedLeaf(
  root: string, leaf: string, expectedDir: string, expected: ExpectedLeafBytes, opts: ReadLeafOptions, keepBytes: boolean,
): Promise<DigestOutcome> {
  const opened = await openConfinedLeaf(root, leaf, expectedDir, opts);
  if (opened.kind !== "confirmed") return { kind: opened.kind, bytes: null };
  try {
    return await digestOpenedLeaf(opened, expected, keepBytes);
  } catch {
    return DIFFERS;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * The size check before any read, the capped stream, the post-read identity
 * check and the digest comparison. With `keepBytes`, a buffer of exactly
 * `expected.byteCount` bytes is allocated once the size is confirmed, and the
 * stream fills it; it is returned only with `matches`.
 */
async function digestOpenedLeaf(opened: ConfirmedLeafOpen, expected: ExpectedLeafBytes, keepBytes: boolean): Promise<DigestOutcome> {
  if (opened.size !== expected.byteCount) return DIFFERS;
  const bytes = keepBytes ? Buffer.alloc(expected.byteCount) : null;
  const streamed = await streamConfinedDigest(bytes === null ? opened : copyingSource(opened, bytes), expected.byteCount);
  if (streamed === null || streamed.total !== expected.byteCount) return DIFFERS;
  const matches = await isSameFile(opened) && streamed.digest === expected.sha256Hex;
  return matches ? { kind: "matches", bytes } : DIFFERS;
}

/** Whether the opened handle is still the same file it was opened as: device, inode, link count, size. */
async function isSameFile(opened: ConfirmedLeafOpen): Promise<boolean> {
  const after = await opened.handle.stat();
  return after.dev === opened.dev && after.ino === opened.ino
    && after.nlink === opened.nlink && after.size === opened.size;
}

/**
 * The opened leaf as the digest loop reads it, with every chunk it reads also
 * copied into `into` at the chunk's own position. A chunk past the end of
 * `into` is not copied; the loop refuses that leaf anyway (it is over the cap).
 */
function copyingSource(opened: ConfirmedLeafOpen, into: Buffer): Parameters<typeof streamConfinedDigest>[0] {
  return {
    size: opened.size,
    handle: {
      read: async (target, offset, length, position) => {
        const read = await opened.handle.read(target, offset, length, position);
        target.copy(into, position, offset, offset + read.bytesRead);
        return read;
      },
    },
  };
}
