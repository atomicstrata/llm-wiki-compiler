/**
 * @file src/operations-packs/compiler-input.ts
 * @description Resolution, validation, and sealing of one pack action's caller
 * input into the frozen initial input set a compiled plan declares (design
 * sections 14.2, 14.3, 11.1).
 *
 * ONE VALIDATOR. A caller value passes the SAME kind and bounds validator a
 * declared default passes (section 14.2: "defaults must pass the same validator
 * as caller values"). Reusing that validator is the point — a second copy is how
 * a caller value comes to be admitted under weaker rules than the pack's own
 * default.
 *
 * ONE EVIDENCE BUILDER. The sealed reference is built by the SAME prepared-input
 * primitive staging uses for a structured seed value, so the reference the plan
 * declares is byte-identical to the one staging will materialize: same canonical
 * bytes, same digest, same byte count, same host capture contract as producer.
 * Building a second evidence reference here would let the plan declare a
 * producer or a byte count the durable evidence never has. The prepared-input id
 * that primitive also mints is DISCARDED: staging mints the durable id from the
 * invoking surface, which the compiler must not choose.
 */

import { prepareStructuredValueInput } from "../preparations/inputs.js";
import type { EvidenceRefV1, EvidenceSensitivity } from "../preparations/types.js";
import { validateInputDefault } from "./parse-input-default.js";
import { PackParseError } from "./problems.js";
import type {
  PackActionInputFieldV2, PackActionInputValueV2, PackActionV2,
} from "./types.js";

/** The evidence kind, media type, and provenance of a sealed action input. */
const ACTION_INPUT_EVIDENCE_KIND = "pack-action-input";
const ACTION_INPUT_MEDIA_TYPE = "application/json";
const ACTION_INPUT_PROVENANCE_LABEL = "pack-action-caller-input";

/** Retention: the input stays readable until the run hands its bundle off. */
const ACTION_INPUT_RETENTION = "until-handoff";

/** Feeds only the discarded prepared-input id; staging mints the durable one. */
const COMPILER_SOURCE_IDENTITY = "compiled-action-input";

/** The resolved input value set plus the evidence the plan and staging share. */
export interface SealedActionInputV1 {
  readonly value: Readonly<Record<string, PackActionInputValueV2>>;
  readonly ref: EvidenceRefV1;
  readonly bytes: Buffer;
}

/**
 * Resolve, validate, and seal one action's caller input. The resolved value —
 * caller values plus the pack's declared defaults for everything omitted — is
 * what the plan seals, so the run's frozen input is the input that will actually
 * be interpreted, not the partial set the caller happened to type.
 */
export function sealActionInput(
  action: PackActionV2, input: Readonly<Record<string, PackActionInputValueV2>>,
): SealedActionInputV1 {
  const schema = new Map(Object.entries(action.inputSchema));
  const supplied = new Map(Object.entries(input));
  for (const fieldId of supplied.keys()) {
    if (!schema.has(fieldId)) throw new PackParseError(`action declares no input field ${fieldId}`);
  }
  const value = resolveValues(schema, supplied);
  const prepared = prepareStructuredValueInput({
    value, sourceIdentity: COMPILER_SOURCE_IDENTITY,
    provenanceLabel: ACTION_INPUT_PROVENANCE_LABEL, mediaType: ACTION_INPUT_MEDIA_TYPE,
    sensitivity: sensitivityOf(schema, value), retention: ACTION_INPUT_RETENTION,
    evidenceKind: ACTION_INPUT_EVIDENCE_KIND,
  });
  return { value, ref: prepared.input.evidenceRef, bytes: prepared.bytes };
}

/** Resolve every declared field to its caller value or its declared default. */
function resolveValues(
  schema: ReadonlyMap<string, PackActionInputFieldV2>,
  supplied: ReadonlyMap<string, PackActionInputValueV2>,
): Record<string, PackActionInputValueV2> {
  const resolved: Record<string, PackActionInputValueV2> = {};
  for (const [fieldId, field] of schema) {
    const value = supplied.get(fieldId);
    if (value !== undefined) {
      assertOverridable(field, fieldId);
      validateInputDefault(field, value, `input.${fieldId}`);
      resolved[fieldId] = value;
      continue;
    }
    if (field.default !== undefined) resolved[fieldId] = field.default;
    else if (field.required) throw new PackParseError(`required action input ${fieldId} is missing`);
  }
  return resolved;
}

/** Refuse a caller value for a field the pack pinned to its own default. */
function assertOverridable(field: PackActionInputFieldV2, fieldId: string): void {
  if (field.default !== undefined && !field.overridable) {
    throw new PackParseError(`action input ${fieldId} is not overridable`);
  }
}

/**
 * The sealed set's sensitivity class: private when any resolved field is
 * declared sensitive, ordinary otherwise. Staging copies this classification
 * onto the durable evidence, so understating it would downgrade the real object.
 */
function sensitivityOf(
  schema: ReadonlyMap<string, PackActionInputFieldV2>,
  value: Readonly<Record<string, PackActionInputValueV2>>,
): EvidenceSensitivity {
  const sensitive = Object.keys(value)
    .some((fieldId) => schema.get(fieldId)?.sensitivityDisplay === "sensitive");
  return sensitive ? "private" : "ordinary";
}
