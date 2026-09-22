/**
 * @file src/operations-packs/handlers/provider-response.ts
 * @description Decoding a provider's answer into CLOSED evidence items.
 *
 * A PROVIDER'S OUTPUT IS THE LEAST TRUSTED DATA IN A RUN. Every other evidence
 * item in the pack runtime is derived from the caller's sealed input or from a
 * previous phase's already-validated output; this is the one place where bytes
 * a model produced become evidence that later phases reconcile against and a
 * terminal drafts pages from. So it is decoded against the phase's DECLARED
 * output schema and refused on any deviation, rather than parsed permissively
 * and cleaned up downstream.
 *
 * IT IS A DECODER, NOT A COERCER. A missing field, an unexpected field, a
 * non-scalar value or a duplicate identity is a REFUSAL. Coercing any of them
 * would let a provider decide the shape of the evidence — and a phase whose
 * output shape is provider-chosen cannot be reconciled against a store whose
 * shape is fixed, which is exactly the vocabulary mismatch that made
 * `identical` unreachable before canonical projections existed.
 *
 * THE SCHEMA IS THE PACK'S, sealed in the plan digest, so what a provider is
 * ALLOWED to return was fixed when the plan was approved — the same way the
 * request it was asked and the envelope it runs under are.
 */

import { PackHostHandlerError } from "./types.js";
import type { PackEvidenceItemV1, PackEvidenceScalarV1 } from "./types.js";

/** One declared output field: its id and the scalar kind it must carry. */
export interface ProviderOutputFieldV1 {
  readonly fieldId: string;
  readonly valueKind: "string" | "integer" | "number" | "boolean";
}

/** The bounded decode one provider response is admitted under. */
export interface ProviderDecodeBoundsV1 {
  readonly maximumItems: number;
}

/** True when `value` matches the declared scalar kind exactly. */
function matchesKind(value: unknown, kind: ProviderOutputFieldV1["valueKind"]): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "boolean") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  // A non-finite number is refused above because canonical digesting cannot
  // represent one — admitting it would throw later, further from the cause.
  return kind === "number" || Number.isInteger(value);
}

/** Decode one item, requiring EXACTLY the declared fields. */
function decodeItem(
  raw: unknown, index: number, fields: readonly ProviderOutputFieldV1[],
): PackEvidenceItemV1 {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PackHostHandlerError(`provider response item ${index} is not an object`);
  }
  const source = raw as Record<string, unknown>;
  const decoded: Record<string, PackEvidenceScalarV1> = {};
  for (const field of fields) {
    const value = source[field.fieldId];
    if (!matchesKind(value, field.valueKind)) {
      throw new PackHostHandlerError(
        `provider response item ${index} field ${field.fieldId} is not a ${field.valueKind}`);
    }
    decoded[field.fieldId] = value as PackEvidenceScalarV1;
  }
  // UNDECLARED FIELDS ARE REFUSED, not dropped. Silently discarding them would
  // hide a provider answering a different question than the one it was asked.
  const undeclared = Object.keys(source).filter(
    (key) => !fields.some((field) => field.fieldId === key) && key !== "itemId");
  if (undeclared.length > 0) {
    throw new PackHostHandlerError(
      `provider response item ${index} carries undeclared field ${undeclared[0]}`);
  }
  const itemId = source.itemId;
  if (typeof itemId !== "string" || itemId.length === 0) {
    throw new PackHostHandlerError(`provider response item ${index} declares no itemId`);
  }
  return { itemId, fields: decoded };
}

/**
 * Decode a provider's response bytes into closed evidence items.
 *
 * @param bytes - The provider's raw answer.
 * @param fields - The phase's declared output fields, from the sealed plan.
 * @param bounds - The phase's item ceiling.
 * @returns One evidence item per returned record, in response order.
 */
export function decodeProviderResponse(
  bytes: Buffer, fields: readonly ProviderOutputFieldV1[], bounds: ProviderDecodeBoundsV1,
): PackEvidenceItemV1[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PackHostHandlerError("provider response is not valid JSON");
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    throw new PackHostHandlerError("provider response declares no items array");
  }
  // The ceiling is checked BEFORE decoding, so an oversized response is refused
  // rather than partially admitted — a truncated answer read as a complete one
  // is a completeness lie the reconcile phase downstream cannot detect.
  if (items.length > bounds.maximumItems) {
    throw new PackHostHandlerError("provider response exceeds the declared item ceiling");
  }
  const decoded = items.map((raw, index) => decodeItem(raw, index, fields));
  const identities = new Set(decoded.map((item) => item.itemId));
  if (identities.size !== decoded.length) {
    throw new PackHostHandlerError("provider response repeats an item identity");
  }
  return decoded;
}
