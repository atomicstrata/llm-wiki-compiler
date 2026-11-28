/**
 * @file src/scale/plan.ts
 * @description Pure planning of an expected scale: parse a person's size and
 * document estimates exactly (no floating-point rounding, no silent overflow),
 * derive a document count when only bytes were given, and select the local
 * architecture the planning policy in `./contracts.ts` assigns — or
 * `unavailable` when the estimate is beyond the local envelope.
 *
 * Nothing here reads or writes disk, and nothing here measures capacity: the
 * result is a plan for intent, under the documented assumptions.
 */

import {
  AVERAGE_DOCUMENT_BYTES, BYTES_PER_EMBEDDING_ENTRY, EMBEDDING_ENTRIES_PER_DOCUMENT, LOCAL_MAX_BYTES, LOCAL_MAX_DOCUMENTS,
  PREFLIGHT_HEADROOM_BYTES, STANDARD_MAX_BYTES, STANDARD_MAX_DOCUMENTS, ScaleRefusalError,
  type EnvelopeBound, type LocalArchitecture, type PlannedArchitecture, type RequestedScaleV1, type ScalePlan, type ScaleRequest,
} from "./contracts.js";

/** Accepted size units: decimal (KB = 1000 B) and binary (KiB = 1024 B). */
const SIZE_UNITS: Readonly<Record<string, bigint>> = Object.freeze({
  b: 1n, kb: 1000n, mb: 1000n ** 2n, gb: 1000n ** 3n, tb: 1000n ** 4n, pb: 1000n ** 5n,
  kib: 1024n, mib: 1024n ** 2n, gib: 1024n ** 3n, tib: 1024n ** 4n, pib: 1024n ** 5n,
});

/** A size: digits, an optional fraction, an optional unit (case-insensitive). */
const SIZE_PATTERN = /^(\d{1,30})(?:\.(\d{1,30}))?\s*([a-z]{1,3})?$/i;

/** Refuse invalid input; nothing is written by any caller that sees this. */
function invalid(message: string): never {
  throw new ScaleRefusalError("scale_invalid_request", message);
}

/** A positive bigint as a safe integer, or a refusal naming `label`. */
function positiveSafe(value: bigint, label: string): number {
  if (value < 1n) invalid(`${label} must be at least 1`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(`${label} exceeds the largest supported integer`);
  return Number(value);
}

/**
 * Parse a size such as `5MB`, `2.5GiB` or `1048576` into exact bytes.
 * A fraction must resolve to whole bytes; the result must be a positive safe integer.
 */
export function parseSizeBytes(text: string): number {
  const match = SIZE_PATTERN.exec(text.trim());
  if (match === null) invalid(`size "${text}" is not a number with an optional unit (B, KB, MB, GB, TB, KiB, MiB, GiB, TiB)`);
  const unit = SIZE_UNITS[(match[3] ?? "b").toLowerCase()];
  if (unit === undefined) invalid(`size unit "${match[3]}" is not supported`);
  const fraction = match[2] ?? "";
  const scale = 10n ** BigInt(fraction.length);
  const scaled = (BigInt(match[1]!) * scale + BigInt(fraction || "0")) * unit;
  if (scaled % scale !== 0n) invalid(`size "${text}" does not resolve to whole bytes`);
  return positiveSafe(scaled / scale, "size");
}

/** Parse a document count: digits only, a positive safe integer. */
export function parseDocumentCount(text: string): number {
  if (!/^\d{1,30}$/.test(text.trim())) invalid(`document count "${text}" must be a whole number`);
  return positiveSafe(BigInt(text.trim()), "document count");
}

/** A present field as a positive safe integer, or a refusal naming `label`. */
function sane(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer`);
  return value;
}

/** Validate an already-numeric request (the SDK path): at least one field, each a positive safe integer; only known fields kept. */
export function validateRequest(request: ScaleRequest): ScaleRequest {
  if (request === null || typeof request !== "object") invalid("an estimate must be an object");
  const { sizeBytes, documents } = request;
  if (sizeBytes === undefined && documents === undefined) invalid("an estimate needs an expected size, an expected document count, or both");
  return {
    ...(sizeBytes === undefined ? {} : { sizeBytes: sane(sizeBytes, "sizeBytes") }),
    ...(documents === undefined ? {} : { documents: sane(documents, "documents") }),
  };
}

/**
 * The recorded estimate. A missing field is DERIVED from the other at the
 * documented average document size, and its basis says so, so a report never
 * implies the person stated an inferred value. A derivation that would not be
 * a safe integer is refused before anything is written.
 */
function requestedScale(request: ScaleRequest): RequestedScaleV1 {
  const { sizeBytes, documents } = validateRequest(request);
  if (sizeBytes !== undefined && documents !== undefined) return { sizeBytes, documents, sizeBasis: "stated", documentsBasis: "stated" };
  if (sizeBytes !== undefined) {
    return { sizeBytes, documents: Math.max(1, Math.ceil(sizeBytes / AVERAGE_DOCUMENT_BYTES)), sizeBasis: "stated", documentsBasis: "derived" };
  }
  const derived = positiveSafe(BigInt(documents!) * BigInt(AVERAGE_DOCUMENT_BYTES), "the size derived from the document count");
  return { sizeBytes: derived, documents: documents!, sizeBasis: "derived", documentsBasis: "stated" };
}

/** Which local-envelope bounds an estimate exceeds (empty when it fits). */
function exceededBounds(requested: RequestedScaleV1): EnvelopeBound[] {
  const exceeds: EnvelopeBound[] = [];
  if (requested.documents > LOCAL_MAX_DOCUMENTS) exceeds.push("documents");
  if (requested.sizeBytes > LOCAL_MAX_BYTES) exceeds.push("bytes");
  return exceeds;
}

/** Plan one estimate under the planning policy. */
export function planScale(request: ScaleRequest): ScalePlan {
  const requested = requestedScale(request);
  const exceeds = exceededBounds(requested);
  if (exceeds.length > 0) return { requested, architecture: "unavailable", exceeds };
  const standard = requested.documents <= STANDARD_MAX_DOCUMENTS && requested.sizeBytes <= STANDARD_MAX_BYTES;
  return { requested, architecture: standard ? "local-standard" : "local-large", exceeds: [] };
}

/** The request a recorded estimate was made from: only its STATED fields. */
function statedRequest(requested: RequestedScaleV1): ScaleRequest {
  return {
    ...(requested.sizeBasis === "stated" ? { sizeBytes: requested.sizeBytes } : {}),
    ...(requested.documentsBasis === "stated" ? { documents: requested.documents } : {}),
  };
}

/** Re-plan a RECORDED estimate on its recorded basis: a derived field is derived again, never restated. */
export function planRecorded(requested: RequestedScaleV1): ScalePlan {
  return planScale(statedRequest(requested));
}

/** Order local architectures so a larger one is a compatible superset of a smaller one. */
function architectureRank(architecture: LocalArchitecture): number {
  return architecture === "local-large" ? 1 : 0;
}

/** Whether `planned` needs a transition from `active` (a smaller or equal plan never does). */
export function needsTransition(active: LocalArchitecture, planned: PlannedArchitecture): planned is "local-large" {
  return planned === "local-large" && architectureRank(active) < architectureRank(planned);
}

/**
 * The CONSERVATIVE free-space requirement of the disk preflight: the full
 * source estimate, an equal allowance for generated pages, the full embedding
 * estimate twice (the JSON backup and the binary container side by side) and
 * fixed headroom. Observed usage is deliberately NOT subtracted, so a partly
 * filled project can never under-budget.
 */
export function preflightRequiredBytes(requested: RequestedScaleV1): number {
  const embeddings = requested.documents * EMBEDDING_ENTRIES_PER_DOCUMENT * BYTES_PER_EMBEDDING_ENTRY;
  const total = requested.sizeBytes * 2 + embeddings * 2 + PREFLIGHT_HEADROOM_BYTES;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}
