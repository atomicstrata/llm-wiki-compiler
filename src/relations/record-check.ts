/**
 * @file src/relations/record-check.ts
 * @description The validators of ONE stored relation record: its shape, its
 * operation binding, its checksum (over the ref AND the binding) and its
 * slug-safe endpoints, plus the record shapes a read returns. Shared by the
 * single-file relation reader (`./store-read.ts`) and the segmented relation
 * log (`../history/relations-*.ts`); a leaf, so the segmented log never
 * imports the reader that dispatches to it.
 */

import { EntityIdError, parseEntityId } from "../profile/identity.js";
import { isOperationBinding, type OperationBinding } from "../utils/operation-binding.js";
import { recordChecksum } from "./store-record.js";
import { RelationStoreCorruptError, type RelationRecord, type RelationRef } from "./types.js";

/** One parsed relation plus the operation binding it carries (when bundle-produced). */
export interface BoundRelationRecord {
  ref: RelationRef;
  operationBinding?: OperationBinding;
}

/** The binding-aware read: every parsed record in file order, plus problems. */
export interface ReadRelationRecordsResult {
  /** Every valid record in append (file) order, carrying any operation binding. */
  records: BoundRelationRecord[];
  /** Human-readable notes about tolerated issues (e.g. a torn trailing line). */
  problems: string[];
}

/** Split a record line into its {@link RelationRef} and stored checksum, validating shape. */
export function parseRecord(line: string): RelationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RelationStoreCorruptError("record line is not valid JSON");
  }
  const rec = parsed as Partial<RelationRecord>;
  const idOk = typeof rec.id === "string" && rec.id.startsWith("rel_");
  if (!idOk || typeof rec.checksum !== "string" || typeof rec.type !== "string") {
    throw new RelationStoreCorruptError("record line is missing required fields");
  }
  return rec as RelationRecord;
}

/**
 * Re-assert both endpoints are slug-safe `<type>/<slug>` ids via
 * {@link parseEntityId} (which validates both halves), symmetrical with the
 * write path's endpoint validation. A well-formed-but-traversal endpoint (e.g.
 * `from: "../../etc/passwd"`) is INTERIOR CORRUPTION, not a benign dangling page,
 * so it fails closed — a future path-deriving consumer cannot inherit a traversal.
 */
function assertEndpointsSlugSafe(ref: RelationRef): void {
  try {
    parseEntityId(ref.from);
    parseEntityId(ref.to);
  } catch (err) {
    if (err instanceof EntityIdError) {
      throw new RelationStoreCorruptError(`relation ${ref.id} has a non-slug-safe endpoint: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Verify a parsed record's stored checksum + endpoint slug-safety, returning the
 * pure {@link RelationRef} plus any operation binding it carries. A present-but-
 * malformed binding is interior corruption (fail closed). The checksum is
 * recomputed over the ref AND the binding, so binding tampering is detectable.
 */
export function verifyChecksum(record: RelationRecord): BoundRelationRecord {
  const { checksum, operationBinding, ...ref } = record;
  if (operationBinding !== undefined && !isOperationBinding(operationBinding)) {
    throw new RelationStoreCorruptError(`relation ${ref.id} has a malformed operation binding`);
  }
  if (recordChecksum(ref, operationBinding) !== checksum) {
    throw new RelationStoreCorruptError(`checksum mismatch for relation ${ref.id}`);
  }
  assertEndpointsSlugSafe(ref);
  return { ref, ...(operationBinding === undefined ? {} : { operationBinding }) };
}

/**
 * Validate one STORED relation value of the segmented relation log
 * (`local-indexed`): the same shape, binding, checksum and endpoint checks a
 * JSONL line gets here. Any failure is {@link RelationStoreCorruptError}.
 */
export function checkedRelationRecord(value: unknown): BoundRelationRecord {
  return verifyChecksum(parseRecord(JSON.stringify(value)));
}
