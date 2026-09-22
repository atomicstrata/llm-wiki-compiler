/**
 * @file src/utils/advisory-file.ts
 * @description Shared mechanics for a lock-free advisory sidecar file — the
 * `.cancel` request pattern used by both operation bundles and preparations
 * (design section 23.1). It owns ONLY the non-authoritative filesystem
 * mechanics: create-only publication, a confined no-follow single-link bounded
 * read, and best-effort removal. It never owns the per-domain record shape,
 * identity binding, or validation — each caller keeps its own closed record and
 * canonicalization. An advisory file is intent, never signed state: a forged,
 * oversize, or symlinked file reads as `unavailable` and is never trusted.
 */

import { rm, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { AtomicWriteCollisionError, atomicWriteNoReplace } from "./atomic-write.js";
import { rmdirConfinedDurable, unlinkConfinedLeafDurable } from "./confined-delete.js";
import { readConfinedLeafBuffer } from "./confined-read.js";
import { lstatLeaf } from "./fs-presence.js";

/** Absent, an unreadable/forged/oversize leaf, or the present bounded bytes. */
type AdvisoryFileBytesRead =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "present"; body: Buffer };

/**
 * Publish one create-only advisory file. An existing file is left untouched and
 * reported as `exists`; the caller never replaces authoritative-adjacent bytes.
 */
export async function writeAdvisoryCreateOnly(root: string, filePath: string, bytes: Buffer): Promise<"created" | "exists"> {
  try {
    await atomicWriteNoReplace(filePath, bytes, { confineRoot: root, exactParent: true, mode: 0o600 });
    return "created";
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) return "exists";
    throw error;
  }
}

/**
 * Read one advisory leaf confined, no-follow, single-link, and byte-capped. A
 * path fault or a non-regular/oversize/symlinked leaf is `unavailable`.
 *
 * MODULE-PRIVATE, deliberately. Every domain now reads through
 * {@link readAdvisoryRecord}, which pairs these mechanics with the caller's own
 * parser and ONE classification of the result. Re-exposing the raw bytes would
 * be the seam through which a second, subtly different classification of
 * "unavailable" gets written.
 */
async function readAdvisoryBytes(root: string, filePath: string, expectedDir: string, maxBytes: number): Promise<AdvisoryFileBytesRead> {
  let read: Awaited<ReturnType<typeof readConfinedLeafBuffer>>;
  try {
    read = await readConfinedLeafBuffer(root, filePath, expectedDir, maxBytes, { requireSingleLink: true });
  } catch {
    return { kind: "unavailable" };
  }
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind !== "ok") return { kind: "unavailable" };
  return { kind: "present", body: read.body };
}

/** Absent, a validated present record, or an unreadable/forged/oversize leaf. */
export type AdvisoryRecordRead<T> =
  | { status: "absent" }
  | { status: "present"; request: T }
  | { status: "unavailable"; detail: string };

/**
 * Read one advisory leaf and hand its bytes to the caller's OWN parser.
 *
 * ONE HOME for the read-then-parse-then-classify shape. The two advisory domains
 * — operation bundles and preparations — each kept a byte-identical copy of it,
 * differing only in which parser they called, and a copy of a classification is a
 * copy that can come to disagree about what "unavailable" means. This owns the
 * mechanics and the taxonomy; the caller still owns the record shape, the
 * identity binding and the canonicalization, which is the split this module's
 * header already draws.
 *
 * A THROWING PARSER IS AN INVALID RECORD, not a fault to propagate: the parsers
 * signal rejection by throwing, and the whole point of the advisory contract is
 * that a forged file is never trusted and never raises out of a poll.
 *
 * THE DETAIL STRINGS SAY "cancel" because both callers carry cancel advisories
 * and these are the exact messages both already shipped. They are preserved
 * verbatim rather than generalized: this extraction is behaviour-preserving, and
 * changing an operator-visible string in it would hide a real change inside a
 * refactor. A third advisory kind would make them a parameter.
 *
 * @param root - The confinement root every read stays inside.
 * @param filePath - The advisory leaf to read.
 * @param expectedDir - The directory the leaf must actually live in.
 * @param maxBytes - The inclusive byte cap on the record.
 * @param parse - The domain's own parser, which throws to reject.
 * @returns Absent, the parsed record, or an honest unavailable reason.
 */
export async function readAdvisoryRecord<T>(
  root: string, filePath: string, expectedDir: string, maxBytes: number,
  parse: (bytes: Buffer) => T,
): Promise<AdvisoryRecordRead<T>> {
  const read = await readAdvisoryBytes(root, filePath, expectedDir, maxBytes);
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind !== "present") return { status: "unavailable", detail: "cancel leaf is unreadable" };
  try {
    return { status: "present", request: parse(read.body) };
  } catch {
    return { status: "unavailable", detail: "cancel request is invalid" };
  }
}

/**
 * Remove any removable shape planted at the advisory path — a regular file, a
 * symlink, or a directory — best-effort under the caller's project lock. An
 * un-removable residual is swallowed: advisory removal is non-authoritative and
 * must never escape as a raw throw out of an enclosing settlement path.
 *
 * Dispatches on the shape ACTUALLY observed rather than removing by pathname.
 * The previous form was a bare recursive `rm` with no confinement of any kind,
 * while `confined-delete.ts` — in this directory — already owned a root-confined,
 * parent-verified, fsynced remover. Every shape that occurs in practice now goes
 * through it.
 *
 * This deliberately does NOT claim to confine the advisory path: the ancestor
 * swap window survives, and §16 clause 5 stays FALSE. See
 * `plans/2026-08-04-clause-5-advisory-removal-design.md`. What changed is the
 * residual's size, not the boundary.
 */
export async function removeAdvisoryBestEffort(root: string, filePath: string, expectedDir: string): Promise<void> {
  try {
    const leaf = await lstatLeaf(filePath);
    if (leaf.kind === "absent") return;
    // An unobservable leaf keeps the prior behaviour rather than being left in
    // place. Removal is what UNWEDGES a run whose advisory is untrusted, so a
    // failed observation must not silently become a permanent strand.
    if (leaf.kind !== "present") return await removePlantedDirectory(root, filePath, expectedDir);
    await removeObservedShape(root, filePath, expectedDir, leaf.stats);
  } catch {
    // Best-effort cleanup of a non-authoritative advisory; never propagate.
  }
}

/** Route one observed shape to the narrowest remover that can clear it. */
async function removeObservedShape(root: string, filePath: string, expectedDir: string, stats: Stats): Promise<void> {
  // `unlink` removes the LINK and never its target, so a symlink needs no
  // confinement beyond not following it — which the `lstat` above already gave.
  if (stats.isSymbolicLink()) return await unlink(filePath);
  if (stats.isFile()) return await unlinkConfinedLeafDurable(root, filePath, expectedDir);
  if (stats.isDirectory()) return await removePlantedDirectory(root, filePath, expectedDir);
  // A fifo, socket or device node planted here is a leaf like any other.
  await unlink(filePath);
}

/**
 * An empty planted directory is removed confined and durably. A NON-EMPTY one is
 * the single residual case that still needs a tree walk, and so the single
 * reason §16 clause 5 is not closed. Leaving it instead would strand the run's
 * cancellation permanently, which the three `cancel-semantics` tests refuted.
 */
async function removePlantedDirectory(root: string, filePath: string, expectedDir: string): Promise<void> {
  try {
    await rmdirConfinedDurable(root, filePath, expectedDir);
  } catch {
    await rm(filePath, { force: true, recursive: true });
  }
}
