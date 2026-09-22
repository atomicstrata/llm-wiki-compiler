/**
 * @file src/operations-packs/parse-phase.ts
 * @description Parser for one PackPhaseV2 (design section 15.2): the common phase
 * declaration — stable id, dependencies, required/optional disposition, input
 * bindings, output schema, finite bounds, missing-input disposition, and optional
 * map / bounded-repeat expansion policy (section 15.3) — plus the kind-specific
 * closed source body dispatched by {@link ./parse-phase-bodies}. Every field is a
 * closed shape (slug / ref-id / closed enum / finite scalar), so no phase can name
 * arbitrary host code (section 16.1) or carry section-10.3 forbidden content.
 */

import { array, enumValue, exact, record, type JsonRecord } from "../operation-bundles/manifest-values.js";
import { MAX_PHASE_DEPENDENCIES, MAX_PHASE_FIELDS, MAX_RECIPE_PHASES } from "./constants.js";
import { assertRefId, assertSlug } from "./ids.js";
import { parsePhaseBody } from "./parse-phase-bodies.js";
import type {
  ExpansionControlsV2, PackPhaseKindV2, PackPhaseV2, PhaseBoundsSourceV2,
  PhaseExpansionPolicyV2, PhaseInputBindingV2, PhaseOutputFieldV2,
} from "./recipe-types.js";
import { assertUniqueStrings, positiveCount, slugList } from "./values.js";

const PHASE_KINDS = [
  "provider", "context", "select", "validate", "render", "reconcile", "intent", "join", "gate",
] as const;
const BINDING_SOURCES = ["action-input", "phase-output", "context-evidence"] as const;
const VALUE_KINDS = [
  "string", "string-list", "boolean", "integer", "number",
  "enum", "entity-ref", "artifact-ref", "source-ref", "evidence-ref",
] as const;
const MISSING_DISPOSITIONS = ["fail", "skip-phase", "treat-as-empty"] as const;
const DUPLICATE_DISPOSITIONS = ["reject", "dedupe", "keep-first", "keep-last"] as const;
const DEFICIT_DISPOSITIONS = ["fail", "record-deficit"] as const;
const PHASE_REQUIRED = [
  "phaseId", "kind", "dependencies", "disposition",
  "inputBindings", "outputSchema", "bounds", "missingInputDisposition", "body",
] as const;
const PHASE_OPTIONAL = ["expansionPolicy"] as const;

/** Parse one closed phase input binding: a stable id, a source, a typed reference. */
function parseInputBinding(value: unknown, label: string): PhaseInputBindingV2 {
  const node = record(value, label);
  exact(node, ["bindingId", "source", "ref"]);
  return {
    bindingId: assertSlug(node.bindingId),
    source: enumValue(node.source, BINDING_SOURCES, `${label}.source`),
    ref: assertRefId(node.ref),
  };
}

/** Parse the bounded, distinct-id phase input-binding list (section 15.2). */
function parseInputBindings(value: unknown, label: string): PhaseInputBindingV2[] {
  const bindings = array(value, label, MAX_PHASE_FIELDS)
    .map((item, index) => parseInputBinding(item, `${label}[${index}]`));
  assertUniqueStrings(bindings.map((binding) => binding.bindingId), label);
  return bindings;
}

/** Parse one declared phase output field: a stable id and a closed value kind. */
function parseOutputField(value: unknown, label: string): PhaseOutputFieldV2 {
  const node = record(value, label);
  exact(node, ["fieldId", "valueKind"]);
  return { fieldId: assertSlug(node.fieldId), valueKind: enumValue(node.valueKind, VALUE_KINDS, `${label}.valueKind`) };
}

/** Parse the bounded, distinct-id phase output schema (section 15.2). */
function parseOutputSchema(value: unknown, label: string): PhaseOutputFieldV2[] {
  const fields = array(value, label, MAX_PHASE_FIELDS)
    .map((item, index) => parseOutputField(item, `${label}[${index}]`));
  assertUniqueStrings(fields.map((field) => field.fieldId), label);
  return fields;
}

/** Parse one phase's finite positive scalar bounds (section 15.2). */
function parsePhaseBounds(value: unknown, label: string): PhaseBoundsSourceV2 {
  const node = record(value, label);
  exact(node, ["maxItems", "maxOutputBytes"]);
  return {
    maxItems: positiveCount(node.maxItems, `${label}.maxItems`),
    maxOutputBytes: positiveCount(node.maxOutputBytes, `${label}.maxOutputBytes`),
  };
}

/** Parse the expansion controls shared by map and bounded-repeat (section 15.3). */
function parseExpansionControls(node: JsonRecord, label: string): ExpansionControlsV2 {
  return {
    duplicateDisposition: enumValue(node.duplicateDisposition, DUPLICATE_DISPOSITIONS, `${label}.duplicateDisposition`),
    overflowDisposition: enumValue(node.overflowDisposition, DEFICIT_DISPOSITIONS, `${label}.overflowDisposition`),
    nonConvergenceDisposition: enumValue(node.nonConvergenceDisposition, DEFICIT_DISPOSITIONS, `${label}.nonConvergenceDisposition`),
    completenessClass: assertSlug(node.completenessClass),
    stableIdentityPolicy: assertSlug(node.stableIdentityPolicy),
  };
}

const CONTROL_KEYS = [
  "duplicateDisposition", "overflowDisposition", "nonConvergenceDisposition",
  "completenessClass", "stableIdentityPolicy",
] as const;

/** Parse the optional map / bounded-repeat expansion policy (section 15.3). */
function parseExpansionPolicy(value: unknown, label: string): PhaseExpansionPolicyV2 {
  const node = record(value, label);
  const kind = enumValue(node.kind, ["map", "bounded-repeat"], `${label}.kind`);
  if (kind === "map") {
    exact(node, ["kind", "maxItems", ...CONTROL_KEYS]);
    return { kind, maxItems: positiveCount(node.maxItems, `${label}.maxItems`), ...parseExpansionControls(node, label) };
  }
  exact(node, ["kind", "maxIterations", ...CONTROL_KEYS]);
  return { kind, maxIterations: positiveCount(node.maxIterations, `${label}.maxIterations`), ...parseExpansionControls(node, label) };
}

/** Parse the common phase declaration fields shared by every kind (section 15.2). */
function parsePhaseCommon(node: JsonRecord, label: string): Omit<PackPhaseV2, "kind" | "body"> {
  const base = {
    phaseId: assertSlug(node.phaseId),
    dependencies: slugList(node.dependencies, `${label}.dependencies`, MAX_PHASE_DEPENDENCIES),
    disposition: enumValue(node.disposition, ["required", "optional"], `${label}.disposition`),
    inputBindings: parseInputBindings(node.inputBindings, `${label}.inputBindings`),
    outputSchema: parseOutputSchema(node.outputSchema, `${label}.outputSchema`),
    bounds: parsePhaseBounds(node.bounds, `${label}.bounds`),
    missingInputDisposition: enumValue(node.missingInputDisposition, MISSING_DISPOSITIONS, `${label}.missingInputDisposition`),
  };
  if (node.expansionPolicy === undefined) return base;
  return { ...base, expansionPolicy: parseExpansionPolicy(node.expansionPolicy, `${label}.expansionPolicy`) };
}

/** Parse one recipe phase: common declaration plus its kind-specific closed body. */
function parsePhase(value: unknown, label: string): PackPhaseV2 {
  const node = record(value, label);
  exact(node, PHASE_REQUIRED, PHASE_OPTIONAL);
  const kind: PackPhaseKindV2 = enumValue(node.kind, PHASE_KINDS, `${label}.kind`);
  const body = parsePhaseBody(kind, node.body, `${label}.body`);
  return { ...parsePhaseCommon(node, label), kind, body } as PackPhaseV2;
}

/** Parse the bounded, distinct-id phase list of one recipe (section 15.2). */
export function parsePhases(value: unknown, label: string): PackPhaseV2[] {
  const phases = array(value, label, MAX_RECIPE_PHASES).map((item, index) => parsePhase(item, `${label}[${index}]`));
  assertUniqueStrings(phases.map((phase) => phase.phaseId), label);
  return phases;
}
