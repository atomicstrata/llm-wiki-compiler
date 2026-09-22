/**
 * @file src/operations-packs/parse-input-field.ts
 * @description Parser for the closed 13-kind PackActionInputFieldV2 tagged union
 * (design section 14.2). Each field declares the common required/overridable/
 * sensitivity/guided metadata plus exactly the bounds its kind requires; unknown
 * or missing keys fail closed per kind, and defaults are parsed with the same
 * bounded value reader as caller values. Raw secrets, executable paths, shell
 * fragments, arbitrary JSON, and writable paths are not representable kinds.
 */

import {
  booleanValue, enumValue, exact, record, type JsonRecord,
} from "../operation-bundles/manifest-values.js";
import { MAX_CLOSED_STRING_SET } from "./constants.js";
import { assertMessageKey, assertRefId, assertRoleId, assertSlug } from "./ids.js";
import { validateInputDefault } from "./parse-input-default.js";
import { PackParseError } from "./problems.js";
import type {
  InputFieldCommonV2, InputSensitivityClassV2, PackActionInputFieldV2, PackActionInputKindV2,
} from "./types.js";
import {
  closedValueSet, finiteNumberValue, inputValue, positiveCount, safeIntegerValue, slugList,
} from "./values.js";

const INPUT_FIELD_KINDS = [
  "string", "string-list", "boolean", "integer", "number", "enum", "entity-ref",
  "artifact-ref", "source-ref", "caller-file", "uri", "provider-role", "output-format",
] as const;
type InputFieldKind = (typeof INPUT_FIELD_KINDS)[number];

const SENSITIVITY_CLASSES = ["normal", "sensitive"] as const;
const COMMON_REQUIRED = ["kind", "required", "overridable", "sensitivityDisplay"] as const;
const COMMON_OPTIONAL = ["guidedPresentationKey", "default"] as const;

/** The exact extra key set each field kind declares beyond the common fields. */
const KIND_KEYS: Readonly<Record<InputFieldKind, { required: readonly string[]; optional: readonly string[] }>> = {
  string: { required: ["maxBytes"], optional: ["patternId"] },
  "string-list": { required: ["maxItems", "maxItemBytes"], optional: [] },
  boolean: { required: [], optional: [] },
  integer: { required: ["minimum", "maximum"], optional: [] },
  number: { required: ["minimum", "maximum"], optional: [] },
  enum: { required: ["values"], optional: [] },
  "entity-ref": { required: ["allowedEntityTypes"], optional: [] },
  "artifact-ref": { required: ["allowedArtifactTypes"], optional: [] },
  "source-ref": { required: [], optional: [] },
  "caller-file": { required: ["inputPolicyId"], optional: [] },
  uri: { required: ["allowedSchemes", "maxBytes"], optional: [] },
  "provider-role": { required: ["roleId"], optional: [] },
  "output-format": { required: ["formatId"], optional: [] },
};

/**
 * Require a range whose minimum does not exceed its maximum. The `integer` kind
 * reads safe integers; the `number` kind reads finite numbers, so a fractional
 * `number` bound (section 14.2) is not wrongly narrowed to a safe integer.
 */
function parseRange(
  node: JsonRecord, label: string, readBound: (value: unknown, boundLabel: string) => number,
): { minimum: number; maximum: number } {
  const minimum = readBound(node.minimum, `${label} minimum`);
  const maximum = readBound(node.maximum, `${label} maximum`);
  if (minimum > maximum) throw new PackParseError(`${label} minimum exceeds maximum`);
  return { minimum, maximum };
}

/**
 * Parse the common metadata every input field declares (section 14.2). A declared
 * `default` is read structurally and then validated against the field's own
 * kind + bounds (`kindPart`), so a default must pass the SAME validator a caller
 * value would (14.2) — an over-long, out-of-range, or off-enum default fails here.
 */
function parseCommon(node: JsonRecord, label: string, kindPart: PackActionInputKindV2): InputFieldCommonV2 {
  const base: InputFieldCommonV2 = {
    required: booleanValue(node.required, `${label} required`),
    overridable: booleanValue(node.overridable, `${label} overridable`),
    sensitivityDisplay: enumValue(node.sensitivityDisplay, SENSITIVITY_CLASSES, `${label} sensitivityDisplay`) as InputSensitivityClassV2,
  };
  const withKey = node.guidedPresentationKey === undefined
    ? base : { ...base, guidedPresentationKey: assertMessageKey(node.guidedPresentationKey) };
  if (node.default === undefined) return withKey;
  const value = inputValue(node.default, `${label} default`);
  validateInputDefault(kindPart, value, `${label} default`);
  return { ...withKey, default: value };
}

/** Parse the string field's byte bound and optional closed pattern id. */
function parseStringPart(node: JsonRecord, label: string): PackActionInputKindV2 {
  const maxBytes = positiveCount(node.maxBytes, `${label} maxBytes`);
  return node.patternId === undefined
    ? { kind: "string", maxBytes }
    : { kind: "string", maxBytes, patternId: assertRefId(node.patternId) };
}

/**
 * The kind-specific builder for each input field kind. Dispatching through this
 * closed table keeps the per-kind logic flat and each builder single-branch; the
 * `exact` key set for the kind is enforced by the caller before a builder runs.
 */
const KIND_BUILDERS: Readonly<Record<InputFieldKind, (node: JsonRecord, label: string) => PackActionInputKindV2>> = {
  string: parseStringPart,
  "string-list": (node, label) => ({ kind: "string-list", maxItems: positiveCount(node.maxItems, `${label} maxItems`), maxItemBytes: positiveCount(node.maxItemBytes, `${label} maxItemBytes`) }),
  boolean: () => ({ kind: "boolean" }),
  integer: (node, label) => ({ kind: "integer", ...parseRange(node, label, safeIntegerValue) }),
  number: (node, label) => ({ kind: "number", ...parseRange(node, label, finiteNumberValue) }),
  enum: (node, label) => ({ kind: "enum", values: closedValueSet(node.values, `${label} values`, MAX_CLOSED_STRING_SET) }),
  "entity-ref": (node, label) => ({ kind: "entity-ref", allowedEntityTypes: slugList(node.allowedEntityTypes, `${label} allowedEntityTypes`, MAX_CLOSED_STRING_SET) }),
  "artifact-ref": (node, label) => ({ kind: "artifact-ref", allowedArtifactTypes: slugList(node.allowedArtifactTypes, `${label} allowedArtifactTypes`, MAX_CLOSED_STRING_SET) }),
  "source-ref": () => ({ kind: "source-ref" }),
  "caller-file": (node) => ({ kind: "caller-file", inputPolicyId: assertRefId(node.inputPolicyId) }),
  uri: (node, label) => ({ kind: "uri", allowedSchemes: slugList(node.allowedSchemes, `${label} allowedSchemes`, MAX_CLOSED_STRING_SET), maxBytes: positiveCount(node.maxBytes, `${label} maxBytes`) }),
  "provider-role": (node) => ({ kind: "provider-role", roleId: assertRoleId(node.roleId) }),
  "output-format": (node) => ({ kind: "output-format", formatId: assertSlug(node.formatId) }),
};

/** Parse and structurally validate one closed input field (section 14.2). */
export function parseInputField(value: unknown, label: string): PackActionInputFieldV2 {
  const node = record(value, label);
  const kind = enumValue(node.kind, INPUT_FIELD_KINDS, `${label} kind`);
  const extra = KIND_KEYS[kind];
  exact(node, [...COMMON_REQUIRED, ...extra.required], [...COMMON_OPTIONAL, ...extra.optional]);
  const kindPart = KIND_BUILDERS[kind](node, label);
  return { ...parseCommon(node, label, kindPart), ...kindPart };
}
