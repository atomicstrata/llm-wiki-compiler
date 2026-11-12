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
 *
 * TWO READS, OVER THE READER'S OWN LEAF. What makes a leaf acceptable evidence
 * is decided in the two bodies, `readPreparationEvidenceFrom` and
 * `readPreparationEvidenceBytesFrom`: the digest's shape, checked before the
 * store is asked; the byte cap and its two different refusals; the hashing; that
 * every byte of the stated size was read; the digest comparison; and that no
 * bytes are handed on before they verify. They take `PreparationEvidenceLeafReads`
 * and no project root, path or file handle. The store LENDS one opened leaf for
 * one read: its size, positional reads, and whether it is still the same
 * unchanged object. It returns no digest, no verdict and no checked bytes. The
 * root-named readers keep their signatures and reach those bodies over the
 * private local-disk leaf, built on each call; so do the two writers' collision
 * replays, which call the root form. On disk the lend is the same confined,
 * no-follow, single-link open as before, and the handle is closed when the read
 * settles. Nothing here selects a backend.
 *
 * TWO CREATE-ONLY WRITER BODIES, `writePreparationEvidenceCreateOnlyWith` and
 * `streamPreparationEvidenceCreateOnlyWith`, over
 * {@link PreparationEvidenceWriteSteps}. They own the buffer check, the cap, the
 * digest shape, the streamed hashing that is verified BEFORE the create-only
 * link, the closed outcome, and the collision-only re-read. The caller's source
 * handle and the scratch destination are HOST objects reached through two narrow
 * shapes ({@link EvidenceSource}, {@link EvidenceSink}); the local-disk steps keep
 * the hardened no-replace and streamed create-only durable writers and their
 * confinement, exact-parent and mode flags. A collision is reported only for a
 * genuine `AtomicWriteCollisionError`.
 */

import { createHash } from "node:crypto";
import { streamConfinedDigest } from "../utils/stream-digest.js";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  AtomicWriteCollisionError, atomicStreamCreateOnlyDurable, atomicWriteNoReplaceDurable,
} from "../utils/atomic-write.js";
import { openConfinedLeaf, type ConfirmedLeafOpen } from "../utils/confined-read.js";
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

/** The read half of a caller-authorized source: positional reads only. A `FileHandle` satisfies it. */
export interface EvidenceSource {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

/** The write half of the store's scratch destination: positional writes only. */
export interface EvidenceSink {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<unknown>;
}

/** What the evidence writers ask of the store. No member takes a project root. */
export interface PreparationEvidenceWriteSteps {
  /** Create-only durable publication: `collision` ONLY for a genuine `AtomicWriteCollisionError`. */
  createLeaf(location: PreparationEvidenceLocation, digest: string, bytes: Buffer): Promise<"created" | "collision">;
  /**
   * Streamed create-only publication: `produce` fills the scratch sink and returns
   * its byte count, and anything it throws propagates BEFORE any link. `collision`
   * ONLY for a genuine `AtomicWriteCollisionError`.
   */
  streamCreateLeaf(
    location: PreparationEvidenceLocation, digest: string, produce: (sink: EvidenceSink) => Promise<number>,
  ): Promise<{ status: "created"; byteCount: number } | { status: "collision" }>;
  /** The verifying evidence read used for the collision replay. Local: {@link readPreparationEvidence}. */
  readEvidence(location: PreparationEvidenceLocation, digest: string): Promise<PreparationEvidenceRead>;
}

/** The local-disk evidence write steps for one root, built per call. In no package index. */
export function diskPreparationEvidenceWriteSteps(root: string): PreparationEvidenceWriteSteps {
  return {
    createLeaf: async (location, digest, bytes) => {
      const file = preparationPaths(root, location.workspaceId).evidenceFile(location.preparationId, digest);
      try {
        await atomicWriteNoReplaceDurable(file, bytes, { confineRoot: root, exactParent: true, mode: 0o600 });
        return "created";
      } catch (error) {
        if (!(error instanceof AtomicWriteCollisionError)) throw error;
        return "collision";
      }
    },
    streamCreateLeaf: async (location, digest, produce) => {
      const evidenceRoot = preparationPaths(root, location.workspaceId).evidenceRoot(location.preparationId);
      try {
        const streamed = await atomicStreamCreateOnlyDurable(evidenceRoot, digest, produce, { confineRoot: root, exactParent: true, mode: 0o600 });
        return { status: "created", byteCount: streamed.byteCount };
      } catch (error) {
        if (!(error instanceof AtomicWriteCollisionError)) throw error;
        return { status: "collision" };
      }
    },
    readEvidence: (location, digest) => readPreparationEvidence(root, location, digest),
  };
}

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
  return writePreparationEvidenceCreateOnlyWith(diskPreparationEvidenceWriteSteps(root), location, bytes);
}

/** {@link writePreparationEvidenceCreateOnly} over the writer's own steps: the one buffer body. */
export async function writePreparationEvidenceCreateOnlyWith(
  steps: PreparationEvidenceWriteSteps,
  location: PreparationEvidenceLocation,
  bytes: Buffer,
): Promise<EvidenceWriteResult> {
  if (!Buffer.isBuffer(bytes)) throw new Error("preparation evidence must be a buffer");
  if (bytes.byteLength > MAX_PREPARATION_EVIDENCE_OBJECT_BYTES) {
    throw new Error("preparation evidence exceeds the 2 GiB object cap");
  }
  const digest = evidenceDigest(bytes);
  if (await steps.createLeaf(location, digest, bytes) === "created") return "created";
  const existing = await steps.readEvidence(location, digest);
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
  return streamPreparationEvidenceCreateOnlyWith(diskPreparationEvidenceWriteSteps(root), location, source, expectedDigest, maxBytes);
}

/**
 * {@link streamPreparationEvidenceCreateOnly} over the writer's own steps: the one
 * streaming body. The producer hashes, caps and verifies the planned digest
 * before the store links anything; a collision re-reads the existing object.
 */
export async function streamPreparationEvidenceCreateOnlyWith(
  steps: PreparationEvidenceWriteSteps,
  location: PreparationEvidenceLocation,
  source: EvidenceSource,
  expectedDigest: string,
  maxBytes: number = MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
): Promise<EvidenceStreamOutcome> {
  const clean = assertEvidenceDigest(expectedDigest);
  let streamed: Awaited<ReturnType<PreparationEvidenceWriteSteps["streamCreateLeaf"]>>;
  try {
    streamed = await steps.streamCreateLeaf(location, clean, (sink) => copyLeafIntoTemp(source, sink, clean, maxBytes));
  } catch (error) {
    return copyFaultOutcome(error);
  }
  if (streamed.status === "created") return { status: "written", result: "created", byteCount: streamed.byteCount };
  const existing = await steps.readEvidence(location, clean);
  if (existing.status === "ok") return { status: "written", result: "same", byteCount: existing.byteCount };
  throw new Error(`preparation evidence conflict: ${existing.status}`);
}

/**
 * Copy the source handle into the destination temp, hashing and capping bytes,
 * and return the byte count. The digest is verified against the caller's planned
 * value INSIDE the producer so a disagreement discards the temp before any
 * create-only link — no wrong-named or orphan authoritative object is published.
 */
async function copyLeafIntoTemp(
  source: EvidenceSource, dest: EvidenceSink, expectedDigest: string, maxBytes: number,
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

/** Map a producer sentinel to the closed outcome; anything else propagates unchanged. */
function copyFaultOutcome(error: unknown): EvidenceStreamOutcome {
  if (error instanceof EvidenceCopyOversizeError) return { status: "oversize" };
  if (error instanceof EvidenceCopyFaultError) return { status: "read-fault" };
  if (error instanceof EvidenceCopyDigestMismatchError) return { status: "digest-mismatch", digest: error.digest };
  throw error;
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
  return readPreparationEvidenceFrom(diskPreparationEvidenceLeafReads(root), location, digest, maxBytes);
}

/**
 * One evidence leaf the store has opened for ONE read. It carries no path and
 * no file handle. `size` is what the store says the leaf holds; a body bounds
 * its memory by checking that against its cap BEFORE it reads or allocates.
 */
export interface PreparationEvidenceOpenLeaf {
  /** The leaf's size when it was opened. */
  readonly size: number;
  /** A positional read, as a file handle's: fills `target` and says how many bytes it wrote. May reject. */
  read(target: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  /**
   * PHYSICAL ONLY: is this still the same object, with the same size, as when
   * it was opened? It says nothing about how much was read; the body compares
   * its own byte count with `size`. May reject.
   */
  unchanged(): Promise<boolean>;
}

/** What lending a leaf answers: no leaf, a leaf that may not be trusted, or what `use` returned. */
type PreparationEvidenceLeafUse<T> =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "used"; value: T };

/**
 * What the evidence reads ask of the store. Owned by the evidence reader; no
 * read takes a project root.
 */
export interface PreparationEvidenceLeafReads {
  /**
   * Open one leaf by its location and an already-validated digest, run `use`
   * over it, and release it when `use` settles. May throw or reject, for an
   * unsafe identity or otherwise; the bodies catch nothing here.
   */
  useEvidenceLeaf<T>(
    location: PreparationEvidenceLocation, cleanDigest: string,
    use: (leaf: PreparationEvidenceOpenLeaf) => Promise<T>,
  ): Promise<PreparationEvidenceLeafUse<T>>;
}

/**
 * {@link readPreparationEvidence} over the reader's own leaf: the one body. It
 * validates the digest, asks for the leaf, and verifies it HERE by streaming.
 */
export async function readPreparationEvidenceFrom(
  reads: PreparationEvidenceLeafReads,
  location: PreparationEvidenceLocation,
  digest: string,
  maxBytes: number = MAX_PREPARATION_EVIDENCE_OBJECT_BYTES,
): Promise<PreparationEvidenceRead> {
  return withEvidenceLeaf({ reads, location, digest }, (leaf, clean) => streamVerifyEvidence(leaf, clean, maxBytes));
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
  return readPreparationEvidenceBytesFrom(diskPreparationEvidenceLeafReads(root), location, digest, maxBytes);
}

/**
 * {@link readPreparationEvidenceBytes} over the reader's own leaf: the one
 * body. `maxBytes` stays REQUIRED here too, and the bytes are verified HERE
 * before they are returned.
 */
export async function readPreparationEvidenceBytesFrom(
  reads: PreparationEvidenceLeafReads,
  location: PreparationEvidenceLocation,
  digest: string,
  maxBytes: number,
): Promise<PreparationEvidenceBytesRead> {
  return withEvidenceLeaf({ reads, location, digest }, (leaf, clean) => bufferVerifyEvidence(leaf, clean, maxBytes));
}

/** Validate the digest BEFORE the store is asked, then verify the leaf it lends. */
async function withEvidenceLeaf<T>(
  target: { reads: PreparationEvidenceLeafReads; location: PreparationEvidenceLocation; digest: string },
  verify: (leaf: PreparationEvidenceOpenLeaf, digest: string) => Promise<T>,
): Promise<T | { status: "absent" } | { status: "unavailable" }> {
  const clean = assertEvidenceDigest(target.digest);
  const lent = await target.reads.useEvidenceLeaf(target.location, clean, (leaf) => verify(leaf, clean));
  if (lent.kind === "absent") return { status: "absent" };
  if (lent.kind !== "used") return { status: "unavailable" };
  return lent.value;
}

/**
 * The local-disk evidence leaves for one project root, built per call: the
 * closure derives the path and opens the leaf when it is asked. Exported for
 * the store's leaf composition (`store-leaf-reads.ts`) only; in no package index.
 */
export function diskPreparationEvidenceLeafReads(root: string): PreparationEvidenceLeafReads {
  return { useEvidenceLeaf: (location, cleanDigest, use) => useDiskEvidenceLeaf({ root, location, cleanDigest }, use) };
}

/**
 * Lend one confined evidence leaf: the local disk's half of an evidence read.
 * Path derivation and the open come first and may throw. The handle is closed
 * when `use` settles, resolved or rejected, with a failed close suppressed.
 */
async function useDiskEvidenceLeaf<T>(
  target: { root: string; location: PreparationEvidenceLocation; cleanDigest: string },
  use: (leaf: PreparationEvidenceOpenLeaf) => Promise<T>,
): Promise<PreparationEvidenceLeafUse<T>> {
  const opened = await openEvidenceLeaf(target.root, target.location, target.cleanDigest);
  if (opened.kind !== "confirmed") return opened;
  try {
    return { kind: "used", value: await use(diskOpenEvidenceLeaf(opened)) };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** The lent view of one confirmed handle: its size, its reads, and its post-read identity. */
function diskOpenEvidenceLeaf(opened: ConfirmedLeafOpen): PreparationEvidenceOpenLeaf {
  return {
    size: opened.size,
    read: (target, offset, length, position) => opened.handle.read(target, offset, length, position),
    unchanged: async () => sameEvidenceLeaf(opened, await opened.handle.stat()),
  };
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

/**
 * Buffer the lent leaf fully, then require an unchanged leaf AND a complete
 * read, and only then check the digest. A read that ended early is
 * `unavailable` whatever the store says: its unread tail was never written.
 */
async function bufferVerifyEvidence(
  leaf: PreparationEvidenceOpenLeaf,
  digest: string,
  maxBytes: number,
): Promise<PreparationEvidenceBytesRead> {
  try {
    if (leaf.size > maxBytes) return { status: "over-cap" };
    const bytes = Buffer.allocUnsafe(leaf.size);
    let total = 0;
    while (total < bytes.byteLength) {
      const read = await leaf.read(bytes, total, bytes.byteLength - total, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    const unchanged = await leaf.unchanged();
    if (!unchanged || total !== leaf.size) return { status: "unavailable" };
    if (evidenceDigest(bytes) !== digest) return { status: "mismatch" };
    return { status: "ok", bytes };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Stream the lent leaf in bounded chunks, hashing without buffering, then
 * require an unchanged leaf AND a complete read before the digest is compared.
 */
async function streamVerifyEvidence(
  leaf: PreparationEvidenceOpenLeaf,
  digest: string,
  maxBytes: number,
): Promise<PreparationEvidenceRead> {
  try {
    if (leaf.size > maxBytes) return { status: "unavailable" };
    const streamed = await streamConfinedDigest({ size: leaf.size, handle: leaf }, maxBytes);
    if (streamed === null) return { status: "unavailable" };
    const unchanged = await leaf.unchanged();
    if (!unchanged || streamed.total !== leaf.size) return { status: "unavailable" };
    return streamed.digest === digest ? { status: "ok", byteCount: streamed.total } : { status: "mismatch" };
  } catch {
    return { status: "unavailable" };
  }
}

/** PHYSICAL ONLY: the handle is still the same object, with the same link count and size, as when opened. */
function sameEvidenceLeaf(opened: ConfirmedLeafOpen, after: Stats): boolean {
  return after.dev === opened.dev && after.ino === opened.ino && after.nlink === opened.nlink
    && after.size === opened.size;
}
