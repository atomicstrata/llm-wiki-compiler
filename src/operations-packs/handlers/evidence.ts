/**
 * @file src/operations-packs/handlers/evidence.ts
 * @description The shared bounded-evidence primitives every pure host-handler
 * family reuses (design sections 15.3, 16.1), so the item cap, deterministic
 * identity/ordering keys, and the final output-byte ceiling are enforced from ONE
 * place rather than re-derived per family (DRY; fallow duplication). Each helper
 * is total and fails closed: a bound overflow under a fail-closed disposition
 * throws {@link PackHostHandlerError}, and every ordering key is a canonical,
 * type-tagged byte string so a family's output is identical for identical input.
 */

import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { PackHostHandlerError, type PackCompletenessDeficitV1, type PackEvidenceItemV1, type PackEvidenceScalarV1 } from "./types.js";

/** How an over-cap collection is dispositioned: fail closed or count a deficit. */
export type PackOverflowPolicyV1 =
  | { readonly kind: "fail" }
  | { readonly kind: "record-deficit"; readonly completenessClass: string; readonly reason: PackCompletenessDeficitV1["reason"] };

/** The kept prefix of a bounded collection plus the deficit any truncation counts. */
export interface PackCappedV1<T> {
  readonly kept: readonly T[];
  readonly deficit?: PackCompletenessDeficitV1;
}

/** A stable type-tagged key so `1` and `"1"` never collide in an identity/sort key. */
function scalarKey(value: PackEvidenceScalarV1): string {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") return `n:${value}`;
  return `b:${value}`;
}

/** Read one scalar field or the empty-tag sentinel when a field is absent. */
function fieldKey(item: PackEvidenceItemV1, field: string): string {
  const value = item.fields[field];
  return value === undefined ? "u:" : scalarKey(value);
}

/** The canonical identity key of one item over the declared identity fields. */
export function identityKey(item: PackEvidenceItemV1, fields: readonly string[]): string {
  return canonicalBytes(fields.map((field) => fieldKey(item, field))).toString("utf8");
}

/** The canonical sort key of one item over the declared sort fields. */
export function sortKey(item: PackEvidenceItemV1, fields: readonly string[]): string {
  return canonicalBytes(fields.map((field) => fieldKey(item, field))).toString("utf8");
}

/** Stable-sort items by a string key, breaking ties by original index. */
export function stableSortByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, key: keyOf(item) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.index - right.index))
    .map((entry) => entry.item);
}

/** Cap a bounded collection: fail closed, or truncate and count a declared deficit. */
export function capItems<T>(items: readonly T[], maximum: number, policy: PackOverflowPolicyV1): PackCappedV1<T> {
  if (items.length <= maximum) return { kept: items };
  if (policy.kind === "fail") throw new PackHostHandlerError(`bounded item cap of ${maximum} exceeded`);
  return {
    kept: items.slice(0, maximum),
    deficit: { completenessClass: policy.completenessClass, reason: policy.reason, droppedCount: items.length - maximum },
  };
}

/** Fail closed unless one already-assembled result fits the output-byte ceiling. */
export function enforceOutputBytes(result: unknown, maximumOutputBytes: number): void {
  if (canonicalBytes(result).length > maximumOutputBytes) {
    throw new PackHostHandlerError(`output evidence exceeds the ${maximumOutputBytes}-byte ceiling`);
  }
}
