/**
 * @file src/compiler/candidate-sanitize.ts
 * @description Candidate-record sanitization at the bounded read boundary.
 * Legacy and hand-edited records may omit optional metadata, but downstream
 * review commands receive only closed enum values, safe source-state keys,
 * valid connector provenance, and typed-target metadata. Required structural
 * fields remain the responsibility of the candidate reader before this module
 * is called.
 */

import type { ReviewCandidate, SourceState } from "../utils/types.js";
import type { HeldReason, PolicyHeldReasonCode, ReviewMode } from "../review/policy.js";
import type { TrustDecision } from "../trust/decision.js";

/** Default metadata for legacy `compile --review` callers. */
export const DEFAULT_HELD_REASONS: HeldReason[] = [{ code: "manual-review-requested" }];

const VALID_REVIEW_MODES: ReviewMode[] = ["policy", "forced", "imported", "connector"];

const VALID_HELD_REASON_CODES: PolicyHeldReasonCode[] = [
  "low-confidence",
  "contradicted",
  "schema-violating",
  "provenance-violating",
  "all",
  "manual-review-requested",
  "imported-okf",
  "connector-fetched",
];

const VALID_TRUST_DECISIONS: TrustDecision[] = [
  "allow",
  "allow-with-warning",
  "stage-for-review",
  "quarantine",
  "deny",
];

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A present-but-malformed `expectedTargetHash` is replaced with this non-hex
 * sentinel rather than deleted. Deleting it would let a corrupted or hand-edited
 * candidate FAIL OPEN — approval treats an absent hash as "no precondition" and
 * overwrites freely. The sentinel can never equal `sha256Text(...)` (64 hex
 * chars), so the stale-target guard always refuses: fail CLOSED on a damaged
 * precondition. Genuinely absent hashes (create-new candidates) are untouched.
 */
const CORRUPTED_TARGET_HASH = "corrupted-target-hash";

/** Sanitize and default every optional field consumed downstream. */
export function sanitizeCandidate(candidate: ReviewCandidate): ReviewCandidate {
  const generatedAt = typeof candidate.generatedAt === "string"
    ? candidate.generatedAt
    : new Date(0).toISOString();
  const reviewMode: ReviewMode = VALID_REVIEW_MODES.includes(candidate.reviewMode)
    ? candidate.reviewMode
    : "forced";
  const heldReasons = sanitizeHeldReasons(candidate.heldReasons);
  const sourceStates = sanitizeSourceStates(candidate.sourceStates);
  const connectorProvenance = sanitizeConnectorProvenance(candidate.connectorProvenance);
  const result: ReviewCandidate = { ...candidate, generatedAt, reviewMode, heldReasons };
  assignOptionalFields(result, sourceStates, connectorProvenance);
  sanitizeTypedTarget(result);
  return result;
}

/** Assign validated optional objects and remove rejected legacy values. */
function assignOptionalFields(
  result: ReviewCandidate,
  sourceStates: Record<string, SourceState> | undefined,
  provenance: ReviewCandidate["connectorProvenance"],
): void {
  if (sourceStates !== undefined) result.sourceStates = sourceStates;
  else delete result.sourceStates;
  if (provenance !== undefined) result.connectorProvenance = provenance;
  else delete result.connectorProvenance;
}

/** Validate connector provenance read from disk, dropping malformed values. */
function sanitizeConnectorProvenance(raw: unknown): ReviewCandidate["connectorProvenance"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = [
    "connectorId", "connectorVersion", "sourceUrl", "fetchedAt",
    "contentHash", "draftContentHash", "idempotencyKey",
  ];
  for (const key of keys) {
    if (typeof value[key] !== "string") return undefined;
  }
  if (!SHA256_HEX.test(value.contentHash as string)) return undefined;
  if (!SHA256_HEX.test(value.draftContentHash as string)) return undefined;
  if (!SHA256_HEX.test(value.idempotencyKey as string)) return undefined;
  return provenanceFromRecord(value);
}

/** Copy a fully validated provenance record into its closed DTO. */
function provenanceFromRecord(value: Record<string, unknown>): NonNullable<ReviewCandidate["connectorProvenance"]> {
  return {
    connectorId: value.connectorId as string,
    connectorVersion: value.connectorVersion as string,
    sourceUrl: value.sourceUrl as string,
    fetchedAt: value.fetchedAt as string,
    contentHash: value.contentHash as string,
    draftContentHash: value.draftContentHash as string,
    idempotencyKey: value.idempotencyKey as string,
  };
}

/** Drop malformed typed-target metadata in place. */
function sanitizeTypedTarget(candidate: ReviewCandidate): void {
  if (typeof candidate.targetEntityType !== "string") delete candidate.targetEntityType;
  if (!VALID_TRUST_DECISIONS.includes(candidate.trustDecision as TrustDecision)) {
    delete candidate.trustDecision;
  }
  // A present-but-malformed stale-target hash is POISONED, not dropped: dropping
  // it would fail open (approval reads an absent hash as "no precondition"). The
  // sentinel forces the guard to refuse. Only a genuinely absent hash stays absent.
  if (candidate.expectedTargetHash !== undefined
    && (typeof candidate.expectedTargetHash !== "string" || !SHA256_HEX.test(candidate.expectedTargetHash))) {
    candidate.expectedTargetHash = CORRUPTED_TARGET_HASH;
  }
  // A present-but-malformed expect-absent flag also fails CLOSED: normalize any
  // non-true value to true so the guard still refuses if a page exists, rather
  // than dropping the precondition and letting approval overwrite.
  if (candidate.expectTargetAbsent !== undefined && candidate.expectTargetAbsent !== true) {
    candidate.expectTargetAbsent = true;
  }
}

/** Filter held reasons to the closed code vocabulary, defaulting when empty. */
function sanitizeHeldReasons(raw: unknown): HeldReason[] {
  if (!Array.isArray(raw)) return DEFAULT_HELD_REASONS;
  const valid = raw.filter(
    (reason): reason is HeldReason =>
      reason !== null &&
      typeof reason === "object" &&
      typeof (reason as Record<string, unknown>).code === "string" &&
      VALID_HELD_REASON_CODES.includes((reason as HeldReason).code),
  );
  return valid.length > 0 ? valid : DEFAULT_HELD_REASONS;
}

/** True when a source-state key is a safe plain basename. */
function isSourceKeySafe(key: string): boolean {
  return !key.includes("/") && !key.includes("\\") && !key.includes("..");
}

/** Validate and filter a raw `sourceStates` value from disk. */
function sanitizeSourceStates(raw: unknown): Record<string, SourceState> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, SourceState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isSourceStateValid(key, value)) result[key] = value as SourceState;
  }
  return result;
}

/** Return true when both the source key and entry fields are valid. */
function isSourceStateValid(key: string, value: unknown): boolean {
  if (!isSourceKeySafe(key) || !value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.hash === "string" && entry.hash.length > 0 &&
    Array.isArray(entry.concepts) &&
    (entry.concepts as unknown[]).every((concept) => typeof concept === "string") &&
    typeof entry.compiledAt === "string";
}
