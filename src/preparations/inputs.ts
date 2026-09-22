/**
 * @file src/preparations/inputs.ts
 * @description Immutable prepared-input capture (design section 11.1). A caller
 * local file is read through the shared two-layer confined no-follow bounded
 * reader, planned as a host-minted immutable descriptor whose input ID is bound
 * to the stable source identity plus content digest, then materialized by
 * copying its bytes into Task 2's create-only evidence CAS and re-opening the
 * authorized source to re-verify the complete digest and bounded metadata before
 * the descriptor is committed. A single stat-then-open is never sufficient: the
 * copy is proven against an independent second read so a swap between copy and
 * record fails closed. Structured values are canonicalized and stored the same
 * way. Every payload byte stays untrusted even when its digest is valid.
 */

import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { openConfinedLeaf, type ConfinedLeafOpen } from "../utils/confined-read.js";
import { parseInputId } from "../capability-providers/ids.js";
import type { InputIdV1 } from "../capability-providers/types.js";
import { MAX_PREPARATION_EVIDENCE_OBJECT_BYTES } from "./constants.js";
import {
  readPreparationEvidence, streamPreparationEvidenceCreateOnly,
  type EvidenceStreamOutcome, type PreparationEvidenceLocation,
} from "./evidence-store.js";
import type { EvidenceRefV1, EvidenceSensitivity, Sha256Digest } from "./types.js";

/** The closed evidence retention classes carried through a prepared input. */
export type EvidenceRetention = EvidenceRefV1["retention"];

/**
 * The immutable prepared-input object cap: the full 2 GiB evidence-object
 * ceiling (design section 26.1, capacity table). A caller file is copied through
 * the streaming create-only evidence CAS writer, so an object up to this cap is
 * hashed and persisted without ever being buffered whole in memory.
 */
export const MAX_PREPARED_INPUT_OBJECT_BYTES = MAX_PREPARATION_EVIDENCE_OBJECT_BYTES;

const INPUT_ID_DOMAIN = "llmwiki-preparation-input-id-v1";
const INPUT_CONTRACT_DOMAIN = "llmwiki-preparation-input-capture-v1";
const READ_CHUNK_BYTES = 1024 * 1024;
const SHA256_PREFIX = "sha256:";

/** Host contract digest recorded as the producer of every prepared-input copy. */
const HOST_INPUT_CONTRACT_DIGEST =
  `${SHA256_PREFIX}${createHash("sha256").update(INPUT_CONTRACT_DOMAIN).digest("hex")}` as Sha256Digest;

/** Closed metadata shared by every prepared-input source kind. */
export interface PreparedInputMetadataV1 {
  sourceIdentity: string;
  provenanceLabel: string;
  mediaType: string;
  sensitivity: EvidenceSensitivity;
  retention: EvidenceRetention;
  evidenceKind: string;
  sourceAuthorityDigest?: Sha256Digest;
  eligibilityDigest?: Sha256Digest;
}

/** One caller local file read under a confined source-root policy. */
export interface CallerFileSourceV1 extends PreparedInputMetadataV1 {
  sourceRoot: string;
  sourceLeaf: string;
}

/** One structured value canonicalized and stored as immutable evidence. */
export interface StructuredValueSourceV1 extends PreparedInputMetadataV1 {
  value: unknown;
}

/** The immutable host-minted prepared-input descriptor (design section 11.1). */
export interface PreparedInputV1 {
  inputId: InputIdV1;
  kind: string;
  provenanceLabel: string;
  mediaType: string;
  digest: Sha256Digest;
  byteCount: number;
  evidenceRef: EvidenceRefV1;
  sensitivity: EvidenceSensitivity;
  sourceAuthorityDigest?: Sha256Digest;
  eligibilityDigest?: Sha256Digest;
}

/** The captured source identity a materialize recheck must still observe. */
export interface CallerFileIdentityV1 {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  nlink: number;
}

/** A planned caller file: its descriptor plus the identity binding to recheck. */
export interface PreparedCallerFileV1 {
  input: PreparedInputV1;
  digest: string;
  byteCount: number;
  identity: CallerFileIdentityV1;
  source: CallerFileSourceV1;
}

/** Distinct reasons a caller file could not be captured as trusted evidence. */
export type PreparedInputUnavailableCode =
  | "absent"
  | "unavailable"
  | "oversize"
  | "changed-metadata"
  | "changed-digest"
  | "second-read-unavailable";

/** The outcome of planning one caller file: a descriptor or a distinct refusal. */
export type PlanCallerFileOutcomeV1 =
  | { status: "planned"; prepared: PreparedCallerFileV1 }
  | { status: "unavailable"; code: PreparedInputUnavailableCode };

/** The outcome of materializing one planned caller file into the evidence CAS. */
export type MaterializeCallerFileOutcomeV1 =
  | { status: "materialized" }
  | { status: "unavailable"; code: PreparedInputUnavailableCode };

/** Deterministic recheck seam used to exercise a copy/record swap under test. */
export interface MaterializeCallerFileFaultsForTest {
  beforeRecheck?: () => Promise<void>;
}

/** Options bounding one caller-file plan; the cap defaults to the object ceiling. */
export interface PlanCallerFileOptionsV1 {
  maxBytes?: number;
}

/** Return the lowercase SHA-256 hex of already-buffered bytes. */
function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Host-mint one prepared-input ID as a stable slug bound to the source identity
 * and content digest. The host never trusts a provider-supplied ID; a different
 * digest for the same source yields a different ID so a swap cannot alias.
 */
export function mintPreparedInputId(sourceIdentity: string, bareDigest: string): InputIdV1 {
  const hex = createHash("sha256").update([INPUT_ID_DOMAIN, sourceIdentity, bareDigest].join("\0")).digest("hex");
  return parseInputId(hex);
}

/** Build the immutable descriptor shared by caller-file and structured inputs. */
function buildDescriptor(meta: PreparedInputMetadataV1, bareDigest: string, byteCount: number): PreparedInputV1 {
  const digest = `${SHA256_PREFIX}${bareDigest}` as Sha256Digest;
  const evidenceRef: EvidenceRefV1 = {
    kind: meta.evidenceKind, mediaType: meta.mediaType, provenanceLabel: meta.provenanceLabel,
    digest, byteCount, sensitivity: meta.sensitivity, retention: meta.retention,
    producer: { kind: "host", contractDigest: HOST_INPUT_CONTRACT_DIGEST }, untrusted: true,
  };
  return {
    inputId: mintPreparedInputId(meta.sourceIdentity, bareDigest), kind: meta.evidenceKind,
    provenanceLabel: meta.provenanceLabel, mediaType: meta.mediaType, digest, byteCount,
    evidenceRef, sensitivity: meta.sensitivity,
    ...(meta.sourceAuthorityDigest === undefined ? {} : { sourceAuthorityDigest: meta.sourceAuthorityDigest }),
    ...(meta.eligibilityDigest === undefined ? {} : { eligibilityDigest: meta.eligibilityDigest }),
  };
}

/** Capture the identity fields a later recheck must observe unchanged. */
function identityOf(open: Extract<ConfinedLeafOpen, { kind: "confirmed" }>): CallerFileIdentityV1 {
  return { dev: open.dev, ino: open.ino, size: open.size, mode: open.mode, nlink: open.nlink };
}

/** True when two captured caller-file identities match on every bound field. */
function sameIdentity(a: CallerFileIdentityV1, b: CallerFileIdentityV1): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink;
}

/** Open one caller source leaf through the shared confined no-follow reader. */
function openSource(source: CallerFileSourceV1): Promise<ConfinedLeafOpen> {
  return openConfinedLeaf(source.sourceRoot, source.sourceLeaf, path.dirname(source.sourceLeaf), { requireSingleLink: true });
}

/** Hash a confirmed handle in bounded chunks without buffering the whole file. */
async function streamHandleDigest(handle: FileHandle, maxBytes: number): Promise<{ digest: string; total: number } | "oversize" | "fault"> {
  try {
    const hash = createHash("sha256");
    const scratch = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = await handle.read(scratch, 0, scratch.byteLength, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > maxBytes) return "oversize";
      hash.update(scratch.subarray(0, read.bytesRead));
    }
    return { digest: hash.digest("hex"), total };
  } catch {
    return "fault";
  }
}

/**
 * Plan one caller file: prove it is a confined, no-follow, single-link, in-cap
 * regular file and stream its complete digest without any write, then build the
 * host-minted descriptor and the identity binding a materialize must re-observe.
 */
export async function planCallerFileInput(
  source: CallerFileSourceV1, opts: PlanCallerFileOptionsV1 = {},
): Promise<PlanCallerFileOutcomeV1> {
  const maxBytes = opts.maxBytes ?? MAX_PREPARED_INPUT_OBJECT_BYTES;
  const open = await openSource(source);
  if (open.kind === "absent") return { status: "unavailable", code: "absent" };
  if (open.kind !== "confirmed") return { status: "unavailable", code: "unavailable" };
  try {
    if (open.size > maxBytes) return { status: "unavailable", code: "oversize" };
    const identity = identityOf(open);
    const streamed = await streamHandleDigest(open.handle, maxBytes);
    if (streamed === "oversize") return { status: "unavailable", code: "oversize" };
    if (streamed === "fault" || streamed.total !== open.size) return { status: "unavailable", code: "unavailable" };
    const input = buildDescriptor(source, streamed.digest, streamed.total);
    return { status: "planned", prepared: { input, digest: streamed.digest, byteCount: streamed.total, identity, source } };
  } finally {
    await open.handle.close().catch(() => {});
  }
}

/** Canonicalize one structured value into a stable immutable evidence descriptor. */
export function prepareStructuredValueInput(source: StructuredValueSourceV1): { input: PreparedInputV1; digest: string; bytes: Buffer } {
  const bytes = canonicalBytes(source.value);
  if (bytes.byteLength > MAX_PREPARED_INPUT_OBJECT_BYTES) throw new Error("structured prepared input exceeds the object cap");
  const bare = sha256Hex(bytes);
  return { input: buildDescriptor(source, bare, bytes.byteLength), digest: `${SHA256_PREFIX}${bare}`, bytes };
}

/** Stream the authorized source bytes into the create-only evidence CAS. */
async function copyIntoEvidence(
  root: string, location: PreparationEvidenceLocation, prepared: PreparedCallerFileV1,
): Promise<{ status: "unavailable"; code: PreparedInputUnavailableCode } | { status: "copied" }> {
  const open = await openSource(prepared.source);
  if (open.kind !== "confirmed") return { status: "unavailable", code: "second-read-unavailable" };
  try {
    if (!sameIdentity(identityOf(open), prepared.identity)) return { status: "unavailable", code: "changed-metadata" };
    const streamed = await streamPreparationEvidenceCreateOnly(
      root, location, open.handle, prepared.digest, MAX_PREPARED_INPUT_OBJECT_BYTES,
    );
    return mapEvidenceStreamOutcome(streamed);
  } finally {
    await open.handle.close().catch(() => {});
  }
}

/** Map a streamed-copy outcome onto the closed prepared-input refusal taxonomy. */
function mapEvidenceStreamOutcome(
  streamed: EvidenceStreamOutcome,
): { status: "unavailable"; code: PreparedInputUnavailableCode } | { status: "copied" } {
  switch (streamed.status) {
    case "written": return { status: "copied" };
    case "oversize": return { status: "unavailable", code: "oversize" };
    case "read-fault": return { status: "unavailable", code: "second-read-unavailable" };
    case "digest-mismatch": return { status: "unavailable", code: "changed-digest" };
  }
}

/** Re-open the authorized source and re-verify its identity and complete digest. */
async function recheckSource(prepared: PreparedCallerFileV1): Promise<{ code: PreparedInputUnavailableCode } | null> {
  const open = await openSource(prepared.source);
  if (open.kind === "absent" || open.kind !== "confirmed") return { code: "second-read-unavailable" };
  try {
    if (!sameIdentity(identityOf(open), prepared.identity)) return { code: "changed-metadata" };
    const streamed = await streamHandleDigest(open.handle, MAX_PREPARED_INPUT_OBJECT_BYTES);
    if (streamed === "oversize") return { code: "oversize" };
    if (streamed === "fault") return { code: "second-read-unavailable" };
    return streamed.digest === prepared.digest ? null : { code: "changed-digest" };
  } finally {
    await open.handle.close().catch(() => {});
  }
}

/**
 * Materialize one planned caller file: copy its bytes into the immutable
 * create-only evidence CAS, then reopen the authorized source and require the
 * exact same identity and complete digest before the descriptor is committed.
 * Any swap, changed inode/metadata/digest, or unreadable second pass fails closed.
 */
export async function materializeCallerFileInput(
  root: string, location: PreparationEvidenceLocation, prepared: PreparedCallerFileV1,
  faults: MaterializeCallerFileFaultsForTest = {},
): Promise<MaterializeCallerFileOutcomeV1> {
  const copied = await copyIntoEvidence(root, location, prepared);
  if (copied.status === "unavailable") return copied;
  await faults.beforeRecheck?.();
  const rechecked = await recheckSource(prepared);
  if (rechecked !== null) return { status: "unavailable", code: rechecked.code };
  const present = await readPreparationEvidence(root, location, prepared.digest);
  if (present.status !== "ok") return { status: "unavailable", code: "second-read-unavailable" };
  return { status: "materialized" };
}
