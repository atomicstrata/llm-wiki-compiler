/**
 * @file src/operations-packs/recipe-contracts.ts
 * @description Parsers for a recipe's closed input/output/bounds contracts and its
 * completeness-class sources (design section 15.1, 15.3). Every field is a closed
 * declarative shape: a contract field names a slug id and one closed value kind,
 * an output contract names an evidence class plus registered format ids, and the
 * bounds source carries only finite positive scalar ceilings. No free-form value,
 * path, or expression is representable, so section-10.3 forbidden content cannot
 * hide inside a recipe contract.
 */

import { array, booleanValue, enumValue, exact, record } from "../operation-bundles/manifest-values.js";
import {
  MAX_RECIPE_COMPLETENESS_CLASSES, MAX_RECIPE_CONTRACT_FIELDS, MAX_RECIPE_FORMAT_IDS,
} from "./constants.js";
import { assertSlug } from "./ids.js";
import type {
  CompletenessClassSourceV2, RecipeBoundsSourceV2, RecipeContractFieldV2,
  RecipeInputContractV2, RecipeOutputContractSourceV2,
} from "./recipe-types.js";
import { assertUniqueStrings, positiveCount, slugList } from "./values.js";

const VALUE_KINDS = [
  "string", "string-list", "boolean", "integer", "number",
  "enum", "entity-ref", "artifact-ref", "source-ref", "evidence-ref",
] as const;
const CONTRACT_FIELD_KEYS = ["fieldId", "valueKind", "required"] as const;
const OUTPUT_KEYS = ["evidenceClass", "fields", "formatIds"] as const;
const BOUNDS_KEYS = ["maxPhaseInvocations", "maxTotalItems", "maxOutputBytes"] as const;
const COMPLETENESS_KEYS = ["classId", "disposition"] as const;
const COMPLETENESS_DISPOSITIONS = ["required-complete", "best-effort", "optional"] as const;

/** Parse one closed contract field: a slug id, a closed value kind, disposition. */
function parseContractField(value: unknown, label: string): RecipeContractFieldV2 {
  const node = record(value, label);
  exact(node, CONTRACT_FIELD_KEYS);
  return {
    fieldId: assertSlug(node.fieldId),
    valueKind: enumValue(node.valueKind, VALUE_KINDS, `${label}.valueKind`),
    required: booleanValue(node.required, `${label}.required`),
  };
}

/** Parse a bounded list of distinct-id closed contract fields. */
function parseContractFields(value: unknown, label: string): RecipeContractFieldV2[] {
  const fields = array(value, label, MAX_RECIPE_CONTRACT_FIELDS)
    .map((item, index) => parseContractField(item, `${label}[${index}]`));
  assertUniqueStrings(fields.map((field) => field.fieldId), label);
  return fields;
}

/** Parse the recipe's declared input contract (section 15.1). */
export function parseInputContract(value: unknown, label: string): RecipeInputContractV2 {
  const node = record(value, label);
  exact(node, ["fields"]);
  return { fields: parseContractFields(node.fields, `${label}.fields`) };
}

/** Parse the recipe's declared output contract source (section 15.1). */
export function parseOutputContract(value: unknown, label: string): RecipeOutputContractSourceV2 {
  const node = record(value, label);
  exact(node, OUTPUT_KEYS);
  return {
    evidenceClass: assertSlug(node.evidenceClass),
    fields: parseContractFields(node.fields, `${label}.fields`),
    formatIds: slugList(node.formatIds, `${label}.formatIds`, MAX_RECIPE_FORMAT_IDS),
  };
}

/** Parse the recipe's finite positive scalar bounds source (sections 15.3, 17). */
export function parseRecipeBounds(value: unknown, label: string): RecipeBoundsSourceV2 {
  const node = record(value, label);
  exact(node, BOUNDS_KEYS);
  return {
    maxPhaseInvocations: positiveCount(node.maxPhaseInvocations, `${label}.maxPhaseInvocations`),
    maxTotalItems: positiveCount(node.maxTotalItems, `${label}.maxTotalItems`),
    maxOutputBytes: positiveCount(node.maxOutputBytes, `${label}.maxOutputBytes`),
  };
}

/** Parse one completeness-class source row for counted deficits (section 15.3). */
function parseCompletenessClass(value: unknown, label: string): CompletenessClassSourceV2 {
  const node = record(value, label);
  exact(node, COMPLETENESS_KEYS);
  return {
    classId: assertSlug(node.classId),
    disposition: enumValue(node.disposition, COMPLETENESS_DISPOSITIONS, `${label}.disposition`),
  };
}

/** Parse the bounded, distinct-id completeness-class source list (section 15.3). */
export function parseCompletenessClasses(value: unknown, label: string): CompletenessClassSourceV2[] {
  const classes = array(value, label, MAX_RECIPE_COMPLETENESS_CLASSES)
    .map((item, index) => parseCompletenessClass(item, `${label}[${index}]`));
  assertUniqueStrings(classes.map((entry) => entry.classId), label);
  return classes;
}
