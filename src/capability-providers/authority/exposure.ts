/**
 * @file src/capability-providers/authority/exposure.ts
 * @description Ordered, exact concrete input-exposure snapshots. Confirmation
 * binds the complete provider-visible input list, so any add, replace, remove,
 * or reorder changes the canonical digest before provider execution.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  captureDenseArray, captureExactRecord, captureOwnDataRecord,
} from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import { parseInputId, parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import type { ProviderInputExposureSetV1, ProviderInputRefV1 } from "./types.js";

const MAX_EXPOSURE_INPUTS = 4_096;
const MAX_LABEL_BYTES = 4_096;
const REQUIRED_FIELDS = Object.freeze([
  "inputId", "kind", "provenanceLabel", "mediaType", "digest", "byteCount",
  "materializedToken",
] as const);
const OPTIONAL_FIELD = "sourceAuthorityDigest";

/** Return the canonical ordered input exposure digest required by later plans. */
export function providerExposureDigest(inputs: readonly ProviderInputRefV1[]): Sha256Digest {
  return snapshotProviderExposure(inputs).inputExposureSetDigest;
}

/** Capture the complete input list without retaining caller-owned records. */
export function snapshotProviderExposure(inputs: readonly ProviderInputRefV1[]): ProviderInputExposureSetV1 {
  try {
    const snapshot = captureDenseArray(inputs, MAX_EXPOSURE_INPUTS, parseInput, exposureError);
    const identities = snapshot.map((input) => input.inputId);
    if (new Set(identities).size !== identities.length) throw new Error("provider exposure has duplicate input IDs");
    const digest = parseSha256Digest(canonicalDigest({
      domain: "llmwiki-provider-input-exposure-v1", inputs: snapshot,
    }));
    return Object.freeze({ inputs: snapshot, inputExposureSetDigest: digest });
  } catch (error) {
    if (error instanceof Error && /duplicate input IDs/.test(error.message)) throw error;
    throw exposureError();
  }
}

/** Produce structured host fields for confirmation/status without prose trust. */
export function providerExposureDisplay(exposure: ProviderInputExposureSetV1) {
  const captured = captureExactRecord(exposure, ["inputs", "inputExposureSetDigest"]);
  const snapshot = snapshotProviderExposure(captured.inputs as readonly ProviderInputRefV1[]);
  if (snapshot.inputExposureSetDigest !== parseSha256Digest(captured.inputExposureSetDigest)) throw exposureError();
  return Object.freeze(snapshot.inputs.map((input) => Object.freeze({
    inputId: input.inputId, provenanceLabel: input.provenanceLabel,
    digest: input.digest, byteCount: input.byteCount,
  })));
}

function parseInput(value: unknown): ProviderInputRefV1 {
  const input = captureOwnDataRecord(value);
  const keys = Object.keys(input).sort();
  const expected = input[OPTIONAL_FIELD] === undefined
    ? [...REQUIRED_FIELDS].sort() : [...REQUIRED_FIELDS, OPTIONAL_FIELD].sort();
  if (keys.join("\0") !== expected.join("\0")) throw exposureError();
  const byteCount = positiveInteger(input.byteCount);
  const result = {
    inputId: parseInputId(input.inputId), kind: boundedText(input.kind),
    provenanceLabel: boundedText(input.provenanceLabel), mediaType: mediaType(input.mediaType),
    digest: parseSha256Digest(input.digest), byteCount,
    materializedToken: materializedToken(input.materializedToken),
    ...(input.sourceAuthorityDigest === undefined ? {} : {
      sourceAuthorityDigest: parseSha256Digest(input.sourceAuthorityDigest),
    }),
  };
  return Object.freeze(result);
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value)
    || Buffer.byteLength(value) > MAX_LABEL_BYTES) throw exposureError();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw exposureError();
  return value;
}

/**
 * True when text is a syntactic `type/subtype` media type — the ONE grammar
 * invocation enforces, exported so the pack and plan parsers can refuse a
 * descriptor mediaType at admission instead of stranding runs at invoke.
 */
export function isValidMediaType(text: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(text);
}

function mediaType(value: unknown): string {
  const result = boundedText(value);
  if (!isValidMediaType(result)) throw exposureError();
  return result;
}

function materializedToken(value: unknown): string {
  const token = boundedText(value);
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(token)) throw exposureError();
  return token;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw exposureError();
  return Number(value);
}

function exposureError(): Error { return new Error("provider exposure is invalid"); }
