/**
 * @file src/preparations/evidence-capture.ts
 * @description The ONE fail-closed capture for an untrusted-shaped
 * `EvidenceRefV1` pointer. Every Task 7 host authority binds evidence pointers
 * into a digest or stores them alongside one, so a pointer read through an
 * accessor, a proxy, or a `toJSON` shim could otherwise let the STORED pointer
 * differ from the DIGESTED pointer. Each pointer funnels through here: it is
 * deep-copied into data-only form, checked against the closed field list, and
 * has its digest parsed before anything binds or stores it.
 */

import { parseSha256Digest } from "../capability-providers/ids.js";
import { captureDenseArray, captureExactRecord, deepCaptureData } from "../utils/runtime-capture.js";
import type { EvidenceRefV1 } from "./types.js";

/** The CLOSED field list of one evidence pointer; an extra key fails closed. */
const EVIDENCE_REF_KEYS = Object.freeze([
  "kind", "mediaType", "provenanceLabel", "digest", "byteCount",
  "sensitivity", "retention", "producer", "untrusted",
] as const);

/** The maximum evidence pointers one captured list may carry. */
const MAX_EVIDENCE_REFS = 256;

/** Typed refusal raised when an evidence pointer cannot be safely captured. */
class EvidenceCaptureError extends Error {
  constructor() {
    super("preparation evidence pointer is invalid");
    this.name = "EvidenceCaptureError";
  }
}

/**
 * Deep-capture and validate ONE evidence pointer into an immutable data-only
 * copy. The returned object is what callers must store AND digest; re-reading
 * the caller's original is exactly the split this primitive exists to prevent.
 */
export function captureEvidenceRef(value: unknown): EvidenceRefV1 {
  try {
    const record = captureExactRecord(deepCaptureData(value), EVIDENCE_REF_KEYS);
    return Object.freeze({
      ...record, digest: parseSha256Digest(record.digest),
    }) as unknown as EvidenceRefV1;
  } catch {
    throw new EvidenceCaptureError();
  }
}

/** Capture one bounded evidence-pointer list; a non-array fails closed. */
export function captureEvidenceRefs(
  value: unknown, maximum: number = MAX_EVIDENCE_REFS,
): readonly EvidenceRefV1[] {
  try {
    return captureDenseArray(value, maximum, captureEvidenceRef, () => new EvidenceCaptureError());
  } catch (error) {
    throw error instanceof EvidenceCaptureError ? error : new EvidenceCaptureError();
  }
}
