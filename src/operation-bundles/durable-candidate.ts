/**
 * @file src/operation-bundles/durable-candidate.ts
 * @description Read-only preflight for one durable create-only destination.
 * It mirrors the writer's final, immutable-ready, and disposable-scratch
 * protocol without reconciling any path before the whole stage is accepted.
 */

import {
  durableTempPath, durableWritingPath,
} from "../utils/atomic-write-no-replace-durable.js";
import {
  openConfinedLeaf, readConfirmedBufferOrElse,
} from "../utils/confined-read.js";

interface CandidateLeaf {
  body: Buffer;
  size: number;
  dev: number;
  ino: number;
  nlink: number;
  mode: number;
}

/** Publication work and physical-byte change for one intended destination. */
export interface DurableCandidateInspection {
  authoritative: boolean;
  publicationRequired: boolean;
  physicalByteDelta: number;
}

/** Open and bind one optional protocol path without following any alias. */
async function readCandidateLeaf(
  root: string,
  file: string,
  ownedRoot: string,
  maxBytes: number,
): Promise<CandidateLeaf | undefined> {
  const opened = await openConfinedLeaf(root, file, ownedRoot);
  if (opened.kind === "absent") return undefined;
  if (opened.kind === "unavailable") throw new Error("durable candidate leaf is unavailable");
  const metadata = {
    size: opened.size, dev: opened.dev, ino: opened.ino,
    nlink: opened.nlink, mode: opened.mode,
  };
  const read = await readConfirmedBufferOrElse(
    opened, maxBytes, () => ({ kind: "unavailable" as const }),
  );
  if (read.kind !== "ok") throw new Error("durable candidate leaf is unavailable");
  return { ...metadata, body: read.body };
}

/** Require immutable final or ready bytes and optional protocol mode. */
function assertExact(
  leaf: CandidateLeaf,
  expected: Buffer,
  mode: number | undefined,
  conflict: string,
): void {
  if (!leaf.body.equals(expected) ||
      (mode !== undefined && (leaf.mode & 0o777) !== mode)) {
    throw new Error(conflict);
  }
}

/** Test whether two reserved names identify one physical inode. */
function sameInode(left: CandidateLeaf, right: CandidateLeaf): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Count existing physical bytes once across reserved hard-link aliases. */
function physicalBytes(leaves: readonly (CandidateLeaf | undefined)[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const leaf of leaves) {
    if (leaf === undefined) continue;
    const identity = `${leaf.dev}:${leaf.ino}`;
    if (!seen.has(identity)) total += leaf.size;
    seen.add(identity);
  }
  return total;
}

/** Require one protocol leaf to have no unaccounted hard link. */
function assertSingleLink(leaf: CandidateLeaf | undefined, conflict: string): void {
  if (leaf !== undefined && leaf.nlink !== 1) throw new Error(conflict);
}

/** Require the writer's sole accepted ready-plus-writing pair. */
function assertAliasPair(ready: CandidateLeaf, scratch: CandidateLeaf, conflict: string): void {
  if (sameInode(ready, scratch)) {
    if (ready.nlink !== 2 || scratch.nlink !== 2) throw new Error(conflict);
    return;
  }
  assertSingleLink(ready, conflict);
  assertSingleLink(scratch, conflict);
}

/** Validate the writer's accepted ready/scratch topology without mutation. */
function assertAliasTopology(
  ready: CandidateLeaf | undefined,
  scratch: CandidateLeaf | undefined,
  conflict: string,
): void {
  if (ready === undefined || scratch === undefined) {
    assertSingleLink(ready ?? scratch, conflict);
    return;
  }
  assertAliasPair(ready, scratch, conflict);
}

/** Require a ready companion to be the final inode's sole reserved alias. */
function assertFinalReady(
  final: CandidateLeaf,
  ready: CandidateLeaf | undefined,
  conflict: string,
): void {
  if (ready === undefined) return assertSingleLink(final, conflict);
  if (!sameInode(final, ready) || final.nlink !== 2 || ready.nlink !== 2) throw new Error(conflict);
}

/** Require disposable scratch to be independent from an existing final. */
function assertFinalScratch(
  final: CandidateLeaf,
  scratch: CandidateLeaf | undefined,
  conflict: string,
): void {
  if (scratch !== undefined && sameInode(final, scratch)) throw new Error(conflict);
  assertSingleLink(scratch, conflict);
}

/** Validate an authoritative final plus any writer-reconcilable companions. */
function assertFinalTopology(
  final: CandidateLeaf,
  ready: CandidateLeaf | undefined,
  scratch: CandidateLeaf | undefined,
  conflict: string,
): void {
  assertFinalReady(final, ready, conflict);
  assertFinalScratch(final, scratch, conflict);
}

/** Inspect all three reserved paths before any component can be published. */
export async function inspectDurableCandidate(
  root: string,
  file: string,
  ownedRoot: string,
  expected: Buffer,
  maxBytes: number,
  conflict: string,
  mode?: number,
): Promise<DurableCandidateInspection> {
  const [final, ready, scratch] = await Promise.all([
    readCandidateLeaf(root, file, ownedRoot, maxBytes),
    readCandidateLeaf(root, durableTempPath(file), ownedRoot, maxBytes),
    readCandidateLeaf(root, durableWritingPath(file), ownedRoot, maxBytes),
  ]);
  if (final !== undefined) {
    assertExact(final, expected, mode, conflict);
    if (ready !== undefined) assertExact(ready, expected, mode, conflict);
    assertFinalTopology(final, ready, scratch, conflict);
  } else {
    if (ready !== undefined) assertExact(ready, expected, mode, conflict);
    assertAliasTopology(ready, scratch, conflict);
  }
  const existingBytes = physicalBytes([final, ready, scratch]);
  return {
    authoritative: final !== undefined,
    publicationRequired: final === undefined || ready !== undefined || scratch !== undefined,
    physicalByteDelta: expected.byteLength - existingBytes,
  };
}
