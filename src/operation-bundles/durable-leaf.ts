/**
 * @file src/operation-bundles/durable-leaf.ts
 * @description Handle-bound operation-store reads that accept only the exact
 * same-inode companion aliases reserved by durable create-only publication.
 * Foreign, extra, or changing links remain unavailable.
 */

import type { Stats } from "node:fs";
import path from "node:path";
import { lstat, realpath } from "../utils/fs-metadata.js";
import type { HeldLeaf, ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import {
  openConfinedLeaf, readConfirmedBufferOrElse,
  type CappedLeafRead, type CappedLeafReadBuffer, type ConfinedLeafOpen,
} from "../utils/confined-read.js";
import {
  durableTempPath, durableWritingPath,
} from "../utils/atomic-write-no-replace-durable.js";

/** What the reserved-link check needs of a leaf: its path, identity and link count, from its handle. */
type LinkedLeaf = Pick<Extract<ConfinedLeafOpen, { kind: "confirmed" }>, "leaf" | "dev" | "ino" | "nlink">;

/** Preserve absence while distinguishing an unreadable alias lookup. */
async function optionalStat(file: string): Promise<Stats | null | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

/** Confirm a reserved companion names the same regular-file inode. */
function aliasMatches(opened: LinkedLeaf, alias: Stats): boolean {
  return alias.isFile() && !alias.isSymbolicLink() &&
    alias.dev === opened.dev && alias.ino === opened.ino;
}

/** Match the protocol's stable destination-only or one-companion states. */
function companionLinksMatch(opened: LinkedLeaf, present: Stats[]): boolean {
  if (opened.nlink === 1) return present.length === 0;
  if (opened.nlink !== 2 || present.length !== 1) return false;
  return aliasMatches(opened, present[0]!);
}

/**
 * Require at most one exact protocol-owned hard link beside the destination.
 *
 * The destination itself is not looked up again here. Each call directly
 * follows the confined open's or read's own post-checks, which just proved the
 * parent's realpath and that the canonical destination names the handle's
 * inode; `opened.nlink` is the handle's link count, and the post-read `fstat`
 * requires it unchanged across the read. A held leaf is checked only after
 * {@link heldLeafIsCurrent} asked those same questions of it again, link count
 * included. A second `lstat` of the destination would re-ask exactly them.
 */
async function reservedLinksAreExact(opened: LinkedLeaf): Promise<boolean> {
  const aliases = await Promise.all([
    optionalStat(durableTempPath(opened.leaf)),
    optionalStat(durableWritingPath(opened.leaf)),
  ]);
  if (aliases.includes(null)) return false;
  const present = aliases.filter((item): item is Stats => item !== undefined);
  return companionLinksMatch(opened, present);
}

/**
 * Whether a leaf the pass's walk read is STILL that version at the same
 * confined path: the parent's realpath is the canonical directory the walk's
 * open proved, and the canonical leaf, not followed, is a regular file with
 * that handle's identity, link count, size and modification and change times.
 * These are the path half of the post-read checks of
 * {@link readConfirmedBufferOrElse}, which the walk's read deliberately left
 * to this moment, and a version check besides.
 */
async function heldLeafIsCurrent(held: HeldLeaf): Promise<boolean> {
  const parentReal = await realpath(path.dirname(held.leaf)).catch(() => null);
  if (parentReal !== held.expectedReal) return false;
  const now = await lstat(held.canonicalLeaf).catch(() => null);
  return now !== null && now.isFile() && now.dev === held.dev && now.ino === held.ino && now.nlink === held.nlink
    && now.size === held.size && now.mtimeMs === held.mtimeMs && now.ctimeMs === held.ctimeMs;
}

/**
 * The bytes the pass's walk read from this exact leaf, when the leaf is still
 * that version and its reserved links are exact; otherwise undefined, and the
 * caller reads the disk. The walk read them through the same confined open,
 * within this cap, and found its handle unchanged after the read
 * (`inventory-scan.ts`); the path checks are asked here, before any byte is
 * returned.
 */
async function currentHeldBytes(
  scanned: ScannedLeafBytes | undefined, root: string, file: string, ownedRoot: string, maxBytes: number,
): Promise<Buffer | undefined> {
  const held = scanned?.heldFor(root, file, ownedRoot, maxBytes);
  if (held === undefined || !(await heldLeafIsCurrent(held))) return undefined;
  return await reservedLinksAreExact(held) ? held.body : undefined;
}

/**
 * Read exact raw bytes while accepting only a stable reserved companion. With
 * the pass's `scanned` holder, a leaf its walk already read and that is still
 * the same version is answered from those bytes; any other leaf is read here.
 */
export async function readDurableOperationLeafBuffer(
  root: string,
  file: string,
  ownedRoot: string,
  maxBytes: number,
  scanned?: ScannedLeafBytes,
): Promise<CappedLeafReadBuffer> {
  const held = await currentHeldBytes(scanned, root, file, ownedRoot, maxBytes);
  if (held !== undefined) return { kind: "ok", body: held };
  const opened = await openConfinedLeaf(root, file, ownedRoot);
  if (opened.kind !== "confirmed") return opened;
  if (!(await reservedLinksAreExact(opened))) {
    await opened.handle.close().catch(() => {});
    return { kind: "unavailable" };
  }
  const read = await readConfirmedBufferOrElse(
    opened, maxBytes, () => ({ kind: "unavailable" as const }),
  );
  if (read.kind !== "ok") return read;
  return await reservedLinksAreExact(opened) ? read : { kind: "unavailable" };
}

/** Read one UTF-8 operation record through the same reserved-link contract. */
export async function readDurableOperationLeaf(
  root: string,
  file: string,
  ownedRoot: string,
  maxBytes: number,
  scanned?: ScannedLeafBytes,
): Promise<CappedLeafRead> {
  const read = await readDurableOperationLeafBuffer(root, file, ownedRoot, maxBytes, scanned);
  return read.kind === "ok" ? { kind: "ok", body: read.body.toString("utf8") } : read;
}
