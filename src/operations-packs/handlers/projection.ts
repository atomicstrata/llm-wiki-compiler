/**
 * @file src/operations-packs/handlers/projection.ts
 * @description Applying a pack's CANONICAL PROJECTION: turning caller input
 * into the fields a page of some profile class actually carries.
 *
 * ONE MAPPING, TWO CONSUMERS, APPLIED ONCE. Reconcile compares proposals with
 * what the store already holds; the terminal drafts what gets written. Both
 * need the same canonical fields, and before this existed each derived them
 * separately — reconcile did not derive them at all, comparing the caller's raw
 * INPUT field names against page FRONTMATTER. Unless a pack happened to name its
 * inputs exactly as its page fields the payload digests could never match, so
 * `identical` was unreachable and every re-run reported `conflicting`. The
 * behaviour looked right because both classes fail an `absent` gate; the
 * reported reason was wrong, and a rule that treated the two differently would
 * have broken silently.
 *
 * NO HOST-IDENTITY MAPPING IS REPRESENTABLE HERE, and the refusal is at parse
 * time. A projection feeds a COMPARISON, and a run id or a wall-clock timestamp
 * differs on every run — a projected field carrying one could never equal what
 * the store holds, so `identical` would be unreachable again for a subtler
 * reason. Constants and evidence fields are exactly the sources whose values
 * mean the same thing across two runs.
 */

import { PackHostHandlerError } from "./types.js";
import type { IntentFieldMappingV2 } from "../recipe-types.js";
import type { PackEvidenceItemV1, PackEvidenceScalarV1 } from "./types.js";

/** Resolve one projection mapping; a missing bound input fails closed. */
function projectedValue(
  mapping: IntentFieldMappingV2, item: PackEvidenceItemV1,
): PackEvidenceScalarV1 {
  if (mapping.source === "constant") return mapping.value;
  if (mapping.source === "host-identity") {
    // Unreachable through the parser, which refuses this source on a
    // projection. Kept as a fail-closed floor rather than a silent cast.
    throw new PackHostHandlerError("a canonical projection cannot map a host identity");
  }
  const value = item.fields[mapping.ref];
  if (value === undefined) {
    throw new PackHostHandlerError(`projection is missing bound input ${mapping.ref}`);
  }
  return value;
}

/**
 * Project one evidence item into its canonical fields, keeping its identity.
 *
 * @param mappings - The projection's declared field mappings.
 * @param item - The item to canonicalize.
 * @returns The same identity carrying only the projection's target fields.
 */
export function projectItem(
  mappings: readonly IntentFieldMappingV2[], item: PackEvidenceItemV1,
): PackEvidenceItemV1 {
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const mapping of mappings) fields[mapping.targetField] = projectedValue(mapping, item);
  return { itemId: item.itemId, fields };
}
