/**
 * @file src/operation-bundles/durable-leaf.ts
 * @description Handle-bound operation-store reads that accept only the exact
 * same-inode companion aliases reserved by durable create-only publication.
 * Foreign, extra, or changing links remain unavailable.
 */

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import {
  openConfinedLeaf, readConfirmedBufferOrElse,
  type CappedLeafRead, type CappedLeafReadBuffer, type ConfinedLeafOpen,
} from "../utils/confined-read.js";
import {
  durableTempPath, durableWritingPath,
} from "../utils/atomic-write-no-replace-durable.js";

type ConfirmedLeaf = Extract<ConfinedLeafOpen, { kind: "confirmed" }>;

/** Preserve absence while distinguishing an unreadable alias lookup. */
async function optionalStat(file: string): Promise<Stats | null | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

/** Confirm the destination still names the handle-opened inode. */
function destinationMatches(opened: ConfirmedLeaf, destination: Stats): boolean {
  return destination.dev === opened.dev && destination.ino === opened.ino &&
    destination.nlink === opened.nlink;
}

/** Confirm a reserved companion names the same regular-file inode. */
function aliasMatches(opened: ConfirmedLeaf, alias: Stats): boolean {
  return alias.isFile() && !alias.isSymbolicLink() &&
    alias.dev === opened.dev && alias.ino === opened.ino;
}

/** Match the protocol's stable destination-only or one-companion states. */
function companionLinksMatch(opened: ConfirmedLeaf, present: Stats[]): boolean {
  if (opened.nlink === 1) return present.length === 0;
  if (opened.nlink !== 2 || present.length !== 1) return false;
  return aliasMatches(opened, present[0]!);
}

/** Require the destination plus at most one exact protocol-owned hard link. */
async function reservedLinksAreExact(opened: ConfirmedLeaf): Promise<boolean> {
  const destination = await optionalStat(opened.leaf);
  const aliases = await Promise.all([
    optionalStat(durableTempPath(opened.leaf)),
    optionalStat(durableWritingPath(opened.leaf)),
  ]);
  if (destination === null || destination === undefined || aliases.includes(null)) return false;
  if (!destinationMatches(opened, destination)) return false;
  const present = aliases.filter((item): item is Stats => item !== undefined);
  return companionLinksMatch(opened, present);
}

/** Read exact raw bytes while accepting only a stable reserved companion. */
export async function readDurableOperationLeafBuffer(
  root: string,
  file: string,
  ownedRoot: string,
  maxBytes: number,
): Promise<CappedLeafReadBuffer> {
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
): Promise<CappedLeafRead> {
  const read = await readDurableOperationLeafBuffer(root, file, ownedRoot, maxBytes);
  return read.kind === "ok" ? { kind: "ok", body: read.body.toString("utf8") } : read;
}
