/**
 * @file src/operations-packs/runtime/evidence-scalars.ts
 * @description Pure closed-scalar evidence decoding used by the host runtime.
 */
import type { PackEvidenceScalarV1 } from "../handlers/types.js";

/** True when `value` is a plain data record rather than null or a list. */
export function isDataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode a record's values to closed evidence scalars, or null if any is not one. */
export function scalarFields(record: Record<string, unknown>): Record<string, PackEvidenceScalarV1> | null {
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const [fieldId, value] of Object.entries(record)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
    fields[fieldId] = value;
  }
  return fields;
}

/** True when a sealed input value is a closed evidence scalar. */
export function isEvidenceScalar(value: unknown): value is PackEvidenceScalarV1 {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
