/**
 * @file src/preparations/evidence-store.ts
 * @description The founding authority for immutable preparation-evidence bytes
 * (design section 8.3). Writes are create-only, no-follow, regular-file-only,
 * byte-capped, fsynced, and parent-fsynced through the shared hardened durable
 * writer; an existing digest is accepted only after an exact streaming byte
 * re-verification. Reads are confined, no-follow, nonblocking, single-link,
 * individually capped, and digest-verified. The verifier streams the leaf in
 * bounded chunks so a 2 GiB object is never buffered; the one exception is
 * `readPreparationEvidenceBytes`, which buffers up to its REQUIRED
 * caller-sized cap because returning verified bytes is its job. Evidence bytes are
 * untrusted even when their digest is valid.
 */

import { createHash } from "node:crypto";
import { streamConfinedDigest } from "../utils/stream-digest.js";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  AtomicWriteCollisionError, atomicStreamCreateOnlyDurable, atomicWriteNoReplaceDurable,
} from "../utils/atomic-write.js";
import { openConfinedLeaf } from "../utils/confined-read.js";
import { MAX_PREPARATION_EVIDENCE_OBJECT_BYTES } from "./constants.js";
import type { PreparationId } from "./ids.js";
import { preparationPaths } from "./paths.js";

const EVIDENCE_CHUNK_BYTES = 1024 * 1024;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

/** The workspace and preparation owning one immutable evidence object. */
export interface PreparationEvidenceLocation {
  workspaceId: string;
  preparationId: PreparationId;
}

/** Complete read classification for one immutable evidence leaf. */
export type PreparationEvidenceRead =
  | { status: "ok"; byteCount: number }
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "mismatch" };

/** Outcome of a create-only evidence write and its exact immutable replay. */
export type EvidenceWriteResult = "created" | "same";

/** Return the lowercase SHA-256 hex digest of already-buffered evidence bytes. */
function evidenceDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Require one lowercase SHA-256 evidence digest before any path derivation. */
function assertEvidenceDigest(digest: string): string {
  if (!LOWERCASE_SHA256.test(digest)) throw new Error("preparation evidence digest must be lowercase SHA-256");
  return digest;
}

/**
 * Durably create one immutable evidence blob content-addressed by its own
 * digest, or prove an exact immutable replay. The caller holds the project lock.
 * Bounded host-authored evidence uses this buffer path; streaming caller-file
 * capture is layered on the same create-only namespace by a later task.
 */
export async function writePreparationEvidenceCreateOnly(
  root: string,
  location: PreparationEvidenceLocation,
  bytes: Buffer,
): Promise<EvidenceWriteResult> {
  if (!Buffer.isBuffer(bytes)) throw new Error("preparation evidence must be a buffer");
  if (bytes.byteLength > MAX_PREPARATION_EVIDENCE_OBJECT_BYTES) {
    throw new Error("preparation evidence exceeds the 2 GiB object cap");
  }
  const digest = evidenceDigest(bytes);
  const paths = preparationPaths(root, location.workspaceId);
  const file = paths.evidenceFile(location.preparationId, digest);
  try {
    await atomicWriteNoReplaceDurable(file, bytes, { confineRoot: root, exactParent: true, mode: 0o600 });
    return "created";
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
  }
  const existing = await readPreparationEvidence(root, location, digest);
  if (existing.status === "ok") return "same";
  throw new Error(`preparation evidence conflict: ${existing.status}`);
}

/** Closed outcome of streaming one caller-file leaf into the immutable evidence CAS. */
export type EvidenceStreamOutcome =
  | { status: "written"; result: EvidenceWriteResult; byteCount: number }
  | { status: "oversize" }
  | { status: "read-fault" }
  | { status: "digest-mismatch"; digest: string };

/** Internal sentinels the copy producer throws so a bad copy discards its temp. */
class EvidenceCopyOversizeError extends Error {}
class EvidenceCopyFaultError extends Error {}
class EvidenceCopyDigestMismatchError extends Error {
  constructor(readonly digest: string) { super("evidence copy digest mismatch"); }
}

/**
 * Stream one authorized caller-file handle into the create-only evidence CAS
 * without ever buffering the object in memory. The bytes flow through the shared
 * streamed create-only durable writer (fsync, no-follow-confined parent,
 * create-only link, parent fsync), hashing as they copy and failing closed on an
 * over-cap growth, a read fault, or a digest that disagrees with the planned
 * value; a disagreement discards the temp before any link, so no wrong-named or
 * orphan object is published. The caller holds the project lock.
 */
export async function streamPreparationEvidenceCreateOnly(
  root: string,
  location: PreparationEvidenceLocation,
  source: FileHandle,
  expectedDigest: string,
  maxBytes: number = MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
): Promise<EvidenceStreamOutcome> {
  const clean = assertEvidenceDigest(expectedDigest);
  const paths = preparationPaths(root, location.workspaceId);
  const evidenceRoot = paths.evidenceRoot(location.preparationId);
  try {
    const streamed = await atomicStreamCreateOnlyDurable(evidenceRoot, clean,
      (dest) => copyLeafIntoTemp(source, dest, clean, maxBytes),
      { confineRoot: root, exactParent: true, mode: 0o600 });
    return { status: "written", result: "created", byteCount: streamed.byteCount };
  } catch (error) {
    return classifyCopyOutcome(error, root, location, clean);
  }
}

/**
 * Copy the source handle into the destination temp, hashing and capping bytes,
 * and return the byte count. The digest is verified against the caller's planned
 * value INSIDE the producer so a disagreement discards the temp before any
 * create-only link — no wrong-named or orphan authoritative object is published.
 */
async function copyLeafIntoTemp(
  source: FileHandle, dest: FileHandle, expectedDigest: string, maxBytes: number,
): Promise<number> {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(EVIDENCE_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    let read;
    try {
      read = await source.read(scratch, 0, scratch.byteLength, total);
    } catch { throw new EvidenceCopyFaultError(); }
    if (read.bytesRead === 0) break;
    if (total + read.bytesRead > maxBytes) throw new EvidenceCopyOversizeError();
    await dest.write(scratch, 0, read.bytesRead, total);
    hash.update(scratch.subarray(0, read.bytesRead));
    total += read.bytesRead;
  }
  const digest = hash.digest("hex");
  if (digest !== expectedDigest) throw new EvidenceCopyDigestMismatchError(digest);
  return total;
}

/** Map a copy fault, a collision replay, or a sentinel to the closed outcome. */
async function classifyCopyOutcome(
  error: unknown, root: string, location: PreparationEvidenceLocation, digest: string,
): Promise<EvidenceStreamOutcome> {
  if (error instanceof EvidenceCopyOversizeError) return { status: "oversize" };
  if (error instanceof EvidenceCopyFaultError) return { status: "read-fault" };
  if (error instanceof EvidenceCopyDigestMismatchError) return { status: "digest-mismatch", digest: error.digest };
  if (!(error instanceof AtomicWriteCollisionError)) throw error;
  const existing = await readPreparationEvidence(root, location, digest);
  if (existing.status === "ok") return { status: "written", result: "same", byteCount: existing.byteCount };
  throw new Error(`preparation evidence conflict: ${existing.status}`);
}

/**
 * Read one evidence leaf and verify its bytes hash to the requested digest by
 * streaming bounded chunks off the confined handle. Absence, an untrusted or
 * over-cap leaf, and a byte/digest mismatch stay distinct.
 */
export async function readPreparationEvidence(
  root: string,
  location: PreparationEvidenceLocation,
  digest: string,
  maxBytes: number = MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
): Promise<PreparationEvidenceRead> {
  return withEvidenceLeaf({ root, location, digest }, (opened, clean) => streamVerifyEvidence(opened, clean, maxBytes));
}

/** Outcome of one verified byte read-back: the bytes, or a typed refusal. */
export type PreparationEvidenceBytesRead =
  | { status: "ok"; bytes: Buffer }
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "over-cap" }
  | { status: "mismatch" };

/**
 * Read one evidence object's BYTES back, verified against its digest (R1,
 * runner design v3 §5).
 *
 * The digest is checked over the buffered bytes BEFORE they are returned —
 * reject-then-parse, so no caller ever holds bytes the store has not verified.
 * `maxBytes` is deliberately REQUIRED, unlike the verifier's defaulted cap: the
 * store ceiling is a bound on what may exist, not an authorization to read it,
 * and every call site must state how much it is prepared to parse. An
 * over-`maxBytes` object is a distinct `over-cap` refusal, never a truncation.
 */
export async function readPreparationEvidenceBytes(
  root: string,
  location: PreparationEvidenceLocation,
  digest: string,
  maxBytes: number,
): Promise<PreparationEvidenceBytesRead> {
  return withEvidenceLeaf({ root, location, digest }, (opened, clean) => bufferVerifyEvidence(opened, clean, maxBytes));
}

/** Open one validated digest; the verifier owns closing the confirmed handle. */
async function withEvidenceLeaf<T>(
  target: { root: string; location: PreparationEvidenceLocation; digest: string },
  verify: (opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>, digest: string) => Promise<T>,
): Promise<T | { status: "absent" } | { status: "unavailable" }> {
  const clean = assertEvidenceDigest(target.digest);
  const opened = await openEvidenceLeaf(target.root, target.location, clean);
  if (opened.kind === "absent") return { status: "absent" };
  if (opened.kind !== "confirmed") return { status: "unavailable" };
  return verify(opened, clean);
}

/** Open one evidence leaf under the shared confinement discipline. */
function openEvidenceLeaf(
  root: string, location: PreparationEvidenceLocation, cleanDigest: string,
): ReturnType<typeof openConfinedLeaf> {
  const paths = preparationPaths(root, location.workspaceId);
  return openConfinedLeaf(
    root, paths.evidenceFile(location.preparationId, cleanDigest),
    paths.evidenceRoot(location.preparationId), { requireSingleLink: true },
  );
}

/** Buffer the confirmed handle fully, then verify identity and digest. */
async function bufferVerifyEvidence(
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
  digest: string,
  maxBytes: number,
): Promise<PreparationEvidenceBytesRead> {
  try {
    if (opened.size > maxBytes) return { status: "over-cap" };
    const bytes = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < bytes.byteLength) {
      const read = await opened.handle.read(bytes, total, bytes.byteLength - total, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    const after = await opened.handle.stat();
    if (!sameEvidenceLeaf(opened, after, total)) return { status: "unavailable" };
    if (evidenceDigest(bytes) !== digest) return { status: "mismatch" };
    return { status: "ok", bytes };
  } catch {
    return { status: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Stream the confirmed handle in bounded chunks, hashing without buffering. */
async function streamVerifyEvidence(
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
  digest: string,
  maxBytes: number,
): Promise<PreparationEvidenceRead> {
  try {
    if (opened.size > maxBytes) return { status: "unavailable" };
    const streamed = await streamConfinedDigest(opened, maxBytes);
    if (streamed === null) return { status: "unavailable" };
    const after = await opened.handle.stat();
    if (!sameEvidenceLeaf(opened, after, streamed.total)) return { status: "unavailable" };
    return streamed.digest === digest ? { status: "ok", byteCount: streamed.total } : { status: "mismatch" };
  } catch {
    return { status: "unavailable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Require the post-read handle identity and byte length to remain unchanged. */
function sameEvidenceLeaf(
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
  after: Stats,
  total: number,
): boolean {
  return after.dev === opened.dev && after.ino === opened.ino && after.nlink === opened.nlink
    && after.size === opened.size && total === opened.size;
}
