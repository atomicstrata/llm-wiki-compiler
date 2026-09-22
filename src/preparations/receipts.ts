/**
 * @file src/preparations/receipts.ts
 * @description Fixed-shape signed lifecycle receipts and the unsigned reset-intent
 * marker for two-phase quarantine, key-epoch reset, and prune/sweep (design
 * sections 25.4, 25.5, 26.4). Every authoritative receipt is HMAC-signed by the
 * preparation key that governs the operation (the healthy current key for a
 * per-run quarantine or prune, the fresh reset key for a project reset) over the
 * exact canonical content with `integrity` omitted, so a forged receipt cannot
 * survive verification. The reset-intent marker is deliberately UNSIGNED and
 * non-authoritative: it openly declares that no prior preparation integrity claim
 * is possible and only records that an explicit destructive reset was requested.
 * Nothing here touches the filesystem; the lifecycle stores compose these pure
 * primitives with confined durable I/O.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import type { PreparationPrincipalV1 } from "./run-types.js";
import { isSafeQuarantineComponent } from "./paths.js";
import { canonicalTime } from "./run-parse-helpers.js";

/** Maximum bytes accepted when reading one lifecycle receipt or intent leaf. */
export const MAX_LIFECYCLE_RECEIPT_BYTES = 4 * 1024 * 1024;

const RECEIPT_HMAC_DOMAIN = Buffer.from("llmwiki.preparation-lifecycle-receipt.v1\0", "utf8");

/** Why one two-phase quarantine unit exists (design sections 25.2, 25.3). */
export type QuarantineReason = "run-integrity-invalid" | "missing-key" | "unreadable-key-forced";

/** Whether a quarantine unit scopes one invalid run or a whole-project reset. */
export type QuarantineScope = "per-run" | "project-reset";

/** One byte-preserving move record: source, portable destination, size, digest. */
export interface QuarantineObjectV1 {
  logicalPath: string;
  objectName: string;
  byteCount: number;
  /** Lowercase SHA-256 hex where the source leaf was readable, else null. */
  digest: string | null;
}

/**
 * One superseded-epoch unit a project reset retires: its id and the digest of the
 * completed receipt it carried at retirement time. A reset signs this list with the
 * FRESH key, so it is the only positive, current-key evidence that a unit which can
 * no longer authenticate is finished history rather than unfinished destructive work.
 */
export interface RetiredQuarantineUnitV1 {
  unitId: string;
  receiptDigest: string;
}

/** The signed content of a quarantine planned/completed receipt (integrity omitted). */
export interface QuarantineReceiptContentV1 {
  schemaVersion: 1;
  kind: "quarantine-planned" | "quarantine-completed";
  scope: QuarantineScope;
  reason: QuarantineReason;
  unitId: string;
  runId?: string;
  keyEpochId: string;
  objects: readonly QuarantineObjectV1[];
  residualObligations: readonly string[];
  /** Omitted unless this receipt retires superseded-epoch units (a project reset). */
  retiredUnits?: readonly RetiredQuarantineUnitV1[];
  actor: PreparationPrincipalV1;
  at: string;
}

/** A quarantine receipt authenticated by the governing preparation key. */
export interface QuarantineReceiptV1 extends QuarantineReceiptContentV1 { integrity: string }

/** The signed content of a prune/sweep planned/completed receipt. */
export interface PruneReceiptContentV1 {
  schemaVersion: 1;
  kind: "prune-planned" | "prune-completed";
  operation: "prune" | "sweep";
  unitId: string;
  runId?: string;
  keyEpochId: string;
  objects: readonly { logicalPath: string; byteCount: number; digest: string | null }[];
  actor: PreparationPrincipalV1;
  at: string;
}

/** A prune/sweep receipt authenticated by the healthy current preparation key. */
export interface PruneReceiptV1 extends PruneReceiptContentV1 { integrity: string }

type LifecycleReceiptContent = QuarantineReceiptContentV1 | PruneReceiptContentV1;

/** Compute the domain-separated HMAC over the receipt content minus `integrity`. */
function receiptHmac(key: Buffer, content: LifecycleReceiptContent): string {
  const { ...rest } = content as LifecycleReceiptContent & { integrity?: string };
  delete (rest as { integrity?: string }).integrity;
  return createHmac("sha256", key).update(RECEIPT_HMAC_DOMAIN).update(canonicalBytes(rest)).digest("hex");
}

/** Sign one lifecycle receipt content with the governing preparation key. */
export function signQuarantineReceipt(key: Buffer, content: QuarantineReceiptContentV1): QuarantineReceiptV1 {
  return { ...content, integrity: receiptHmac(key, content) };
}

/** Sign one prune/sweep receipt content with the healthy current preparation key. */
export function signPruneReceipt(key: Buffer, content: PruneReceiptContentV1): PruneReceiptV1 {
  return { ...content, integrity: receiptHmac(key, content) };
}

/**
 * Verify one lifecycle receipt's HMAC against the governing key in constant time.
 * The stored and recomputed values are equal-length lowercase hex; a length guard
 * keeps `timingSafeEqual` from throwing on a malformed stored value.
 */
export function verifyLifecycleReceipt(key: Buffer, receipt: QuarantineReceiptV1 | PruneReceiptV1): boolean {
  const { integrity, ...content } = receipt;
  if (typeof integrity !== "string") return false;
  const expected = receiptHmac(key, content as LifecycleReceiptContent);
  if (integrity.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(integrity, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Parse one bounded receipt leaf into a candidate object WITHOUT trusting it. The
 * caller MUST call {@link verifyLifecycleReceipt} with the governing key before
 * acting on any field: a receipt whose HMAC does not recompute is rejected.
 */
export function parseLifecycleReceipt(text: string): QuarantineReceiptV1 | PruneReceiptV1 {
  const root = parseBoundedUniqueJson(text, MAX_LIFECYCLE_RECEIPT_BYTES);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("preparation lifecycle receipt is not an object");
  }
  const record = root as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.integrity !== "string" || typeof record.kind !== "string") {
    throw new Error("preparation lifecycle receipt shape is invalid");
  }
  return record as unknown as QuarantineReceiptV1 | PruneReceiptV1;
}

/**
 * The unsigned reset-intent marker (design section 25.4 step 4). It carries no
 * integrity claim about prior preparation state, but it DOES commit to the digest of
 * a one-time continuation secret that only pass one returns to the operator. The
 * marker and every other file in the reset unit are attacker-influenceable, so the
 * digest is only a commitment: continuation additionally requires the operator to
 * present the matching secret, which no planted file can supply.
 */
export interface ResetIntentV1 {
  schemaVersion: 1;
  kind: "reset-intent";
  unitId: string;
  reason: "missing-key" | "unreadable-key-forced";
  confirmation: string;
  note: "no prior preparation integrity claim is possible";
  continuationDigest: string;
  actor: PreparationPrincipalV1;
  at: string;
}

/**
 * Whether `value` is EXACTLY a preparation principal. An "is an object" check accepts a
 * principal carrying attacker-supplied fields, which is the same open-grammar hole one
 * level down: the nested record needs its own closed field set.
 */
function isExactPrincipal(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("surface")) return false;
  const principal = value as Record<string, unknown>;
  return [principal.id, principal.surface].every((field) =>
    typeof field === "string" && field !== "" && Buffer.byteLength(field, "utf8") <= MAX_PRINCIPAL_FIELD_BYTES);
}

/** One field's expected shape, checked independently so no predicate accumulates. */
const RESET_INTENT_FIELD_CHECKS: readonly (readonly [string, (value: unknown) => boolean])[] = [
  ["schemaVersion", (value) => value === 1],
  ["kind", (value) => value === "reset-intent"],
  ["unitId", isSafeQuarantineComponent],
  ["confirmation", (value) => typeof value === "string" && value !== ""],
  ["at", isInstant],
  ["reason", (value) => typeof value === "string" && RESET_INTENT_REASONS.has(value)],
  ["note", (value) => value === "no prior preparation integrity claim is possible"],
  ["continuationDigest", (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)],
  ["actor", isExactPrincipal],
];

/** Whether every reset-intent field carries its exact expected shape and value. */
function resetIntentFieldsWellFormed(record: Record<string, unknown>): boolean {
  return RESET_INTENT_FIELD_CHECKS.every(([field, accepts]) => accepts(record[field]));
}

/** Build the fixed-shape reset-intent marker; it carries no integrity by design. */
export function buildResetIntent(input: {
  unitId: string; reason: ResetIntentV1["reason"]; confirmation: string;
  continuationDigest: string; actor: PreparationPrincipalV1; at: string;
}): ResetIntentV1 {
  return {
    schemaVersion: 1, kind: "reset-intent", unitId: input.unitId, reason: input.reason,
    confirmation: input.confirmation, note: "no prior preparation integrity claim is possible",
    continuationDigest: input.continuationDigest,
    actor: { id: input.actor.id, surface: input.actor.surface }, at: input.at,
  };
}

/** The exact field set a reset-intent marker may carry; anything else is foreign. */
const RESET_INTENT_FIELDS = [
  "schemaVersion", "kind", "unitId", "reason", "confirmation", "note",
  "continuationDigest", "actor", "at",
] as const;

/**
 * The destructive confirmation each reset reason demands. These live beside the parser
 * because the PARSER owns the reason/confirmation pairing: when the rule lived only at
 * call sites, a reader that was never audited (the continuation path) accepted a marker
 * whose two fields contradicted each other.
 */
export const MISSING_KEY_CONFIRMATION = "confirm-all-preparation-residual-state";
export const FORCED_KEY_CONFIRMATION = "force-unreadable-key-and-confirm-all-preparation-residual-state";

/** The one confirmation a given reset reason demands. */
export function requiredResetConfirmation(reason: ResetIntentV1["reason"]): string {
  return reason === "missing-key" ? MISSING_KEY_CONFIRMATION : FORCED_KEY_CONFIRMATION;
}

const RESET_INTENT_REASONS = new Set(["missing-key", "unreadable-key-forced"]);

/** Bound on a principal's free-text fields, so a marker cannot carry a payload. */
const MAX_PRINCIPAL_FIELD_BYTES = 256;

/**
 * Whether a value is a canonical UTC instant, not merely a non-empty string. Delegates
 * to the run-parser's rule rather than restating it, so the marker and every other
 * preparation record agree on what a timestamp is.
 */
function isInstant(value: unknown): boolean {
  try {
    canonicalTime(value, "reset-intent timestamp");
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse one bounded reset-intent marker under its CLOSED grammar. Every field must be
 * present and well-formed and no unknown field may appear: the marker is unsigned by
 * design, so its shape is the only structural check standing between a planted file
 * and a path that acts on it. A loose parser would let an attacker attach arbitrary
 * content to an otherwise plausible marker.
 */
export function parseResetIntent(text: string): ResetIntentV1 {
  const root = parseBoundedUniqueJson(text, MAX_LIFECYCLE_RECEIPT_BYTES);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("preparation reset-intent marker is invalid");
  }
  const record = root as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RESET_INTENT_FIELDS.length || keys.some((key) => !RESET_INTENT_FIELDS.includes(key as never))) {
    throw new Error("preparation reset-intent marker has a foreign field set");
  }
  if (!resetIntentFieldsWellFormed(record)) throw new Error("preparation reset-intent marker is invalid");
  // Field-by-field well-formedness is not the contract: a marker whose confirmation
  // contradicts its own reason is internally inconsistent, so whichever field is
  // honest, the other was forged. Checking the RELATIONSHIP here means every reader
  // inherits it, rather than only the call sites that happened to be audited.
  if (record.confirmation !== requiredResetConfirmation(record.reason as ResetIntentV1["reason"])) {
    throw new Error("preparation reset-intent marker records a confirmation its reason does not demand");
  }
  return record as unknown as ResetIntentV1;
}

const RESET_CONTINUATION_DOMAIN = Buffer.from("llmwiki.preparation-reset-continuation.v1\0", "utf8");
const PENDING_RESET_KEY_DOMAIN = Buffer.from("llmwiki.preparation-pending-reset-key.v1\0", "utf8");

/** Digest of a one-time reset continuation secret; only this is stored durably. */
export function resetContinuationDigest(secret: Buffer): string {
  return createHash("sha256").update(RESET_CONTINUATION_DOMAIN).update(secret).digest("hex");
}

/** Constant-time check that a supplied continuation secret matches a stored digest. */
export function matchesContinuationDigest(secret: Buffer, storedDigest: string): boolean {
  const expected = resetContinuationDigest(secret);
  if (typeof storedDigest !== "string" || storedDigest.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(storedDigest, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * The staged fresh reset key material, authenticated by the operator's continuation
 * secret. The key bytes are persisted (create-only) so a crash stays recoverable, but
 * the HMAC binds them to the secret and unit, so a key planted by anyone without the
 * secret is rejected. This crash material is removed once the reset completes durably.
 */
export interface PendingResetKeyV1 {
  schemaVersion: 1;
  kind: "pending-reset-key";
  unitId: string;
  keyEpochId: string;
  key: string;
  integrity: string;
}

/** Compute the domain-separated HMAC binding the staged key to the continuation secret. */
function pendingResetKeyHmac(secret: Buffer, fields: Omit<PendingResetKeyV1, "integrity">): string {
  return createHmac("sha256", secret).update(PENDING_RESET_KEY_DOMAIN).update(canonicalBytes(fields)).digest("hex");
}

/** Authenticate one staged pending reset key under the operator's continuation secret. */
export function signPendingResetKey(secret: Buffer, input: { unitId: string; keyEpochId: string; key: string }): PendingResetKeyV1 {
  const fields = {
    schemaVersion: 1 as const, kind: "pending-reset-key" as const, unitId: input.unitId, keyEpochId: input.keyEpochId, key: input.key,
  };
  return { ...fields, integrity: pendingResetKeyHmac(secret, fields) };
}

/** Verify a staged pending reset key was authenticated by this secret for this unit. */
export function verifyPendingResetKey(secret: Buffer, unitId: string, record: PendingResetKeyV1): boolean {
  if (record.kind !== "pending-reset-key" || record.unitId !== unitId || typeof record.integrity !== "string") return false;
  const { integrity, ...fields } = record;
  const expected = pendingResetKeyHmac(secret, fields);
  if (integrity.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(integrity, "utf8"), Buffer.from(expected, "utf8"));
}

/** Parse one bounded pending-reset-key leaf, rejecting a foreign shape. */
export function parsePendingResetKey(text: string): PendingResetKeyV1 {
  const root = parseBoundedUniqueJson(text, MAX_LIFECYCLE_RECEIPT_BYTES);
  const record = root as Record<string, unknown>;
  if (typeof record !== "object" || record === null || record.schemaVersion !== 1
    || record.kind !== "pending-reset-key" || typeof record.unitId !== "string"
    || typeof record.keyEpochId !== "string" || typeof record.key !== "string"
    || typeof record.integrity !== "string") {
    throw new Error("preparation pending-reset-key record is invalid");
  }
  return record as unknown as PendingResetKeyV1;
}
