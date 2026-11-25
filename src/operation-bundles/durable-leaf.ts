/**
 * @file src/operation-bundles/durable-leaf.ts
 * @description Handle-bound operation-store reads that accept only the exact
 * same-inode companion aliases reserved by durable create-only publication.
 * Foreign, extra, or changing links remain unavailable.
 */

import type { Stats } from "node:fs";
import { lstat } from "../utils/fs-metadata.js";
import type { HeldLeaf, ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import {
  openConfinedLeaf, passesPostOpenChecks, readConfirmedBufferOrElse,
  type CappedLeafRead, type CappedLeafReadBuffer, type ConfirmedLeafOpen,
} from "../utils/confined-read.js";
import {
  durableTempPath, durableWritingPath,
} from "../utils/atomic-write-no-replace-durable.js";

type LinkedLeaf = Pick<ConfirmedLeafOpen, "leaf" | "dev" | "ino" | "nlink">;

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

async function reservedLinksAreExact(opened: LinkedLeaf): Promise<boolean> {
  const aliases = await Promise.all([
    optionalStat(durableTempPath(opened.leaf)),
    optionalStat(durableWritingPath(opened.leaf)),
  ]);
  if (aliases.includes(null)) return false;
  const present = aliases.filter((item): item is Stats => item !== undefined);
  return companionLinksMatch(opened, present);
}

async function heldLeafIsCurrent(held: HeldLeaf): Promise<boolean> {
  const now = await passesPostOpenChecks(held.leaf, held.expectedReal, held.canonicalLeaf, held);
  return now !== null && now.isFile() && now.nlink === held.nlink && now.size === held.size
    && now.mtimeMs === held.mtimeMs && now.ctimeMs === held.ctimeMs;
}

async function provenHeldBytes(held: HeldLeaf): Promise<Buffer | undefined> {
  if (!(await heldLeafIsCurrent(held))) return undefined;
  return await reservedLinksAreExact(held) ? held.body : undefined;
}

const heldProofs = new WeakMap<HeldLeaf, Promise<Buffer | undefined>>();

async function currentHeldBytes(
  scanned: ScannedLeafBytes | undefined, root: string, file: string, ownedRoot: string, maxBytes: number,
): Promise<Buffer | undefined> {
  const held = scanned?.heldFor(root, file, ownedRoot, maxBytes);
  if (held === undefined) return undefined;
  let proof = heldProofs.get(held);
  if (proof === undefined) heldProofs.set(held, proof = provenHeldBytes(held));
  return proof;
}

/** Read exact raw bytes while accepting only a stable reserved companion. */
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
