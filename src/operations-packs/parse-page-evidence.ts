/**
 * @file src/operations-packs/parse-page-evidence.ts
 * @description Byte-level parser for the sealed PAGE-EVIDENCE descriptor
 * (P5c §2a): the CLOSED four-form capture grammar, every field named
 * explicitly, every id a slug, every count positive, every capture's
 * derived-key namespace pairwise distinct. OPTIONAL on the provider body — a
 * plan written before this field existed parses unchanged and reads no page,
 * which is exactly the behaviour it was approved under.
 */

import { PackParseError } from "./problems.js";
import { array, exact, record, type JsonRecord } from "../operation-bundles/manifest-values.js";
import { assertSlug } from "./ids.js";
import { positiveCount } from "./values.js";
import { isValidMediaType } from "../capability-providers/authority/exposure.js";
import type {
  ArtifactDerefCaptureV2, PageEvidenceCaptureV2, PageEvidenceDescriptorV2,
  PageEvidenceExposureV2, PageFieldCaptureV2, RelationTargetCaptureV2, RunBindingCaptureV2,
} from "./recipe-types.js";

/** The runtime's own synthetic input id; no capture may claim it. */
const RESERVED_IDENTITY_INPUT_ID = "page-evidence-identity";

/** The exposure tail every materializing capture carries. */
function parseExposure(node: JsonRecord, label: string): PageEvidenceExposureV2 {
  const mediaType = node.mediaType;
  if (typeof mediaType !== "string" || !isValidMediaType(mediaType)) {
    throw new PackParseError(`${label}.mediaType is not a valid media type`);
  }
  if (node.inputId === RESERVED_IDENTITY_INPUT_ID) {
    throw new PackParseError(`${label}.inputId may not take the runtime's reserved id ${RESERVED_IDENTITY_INPUT_ID}`);
  }
  return {
    inputId: assertSlug(node.inputId), kind: assertSlug(node.kind),
    provenanceLabel: assertSlug(node.provenanceLabel), mediaType,
    maxBytes: positiveCount(node.maxBytes, `${label}.maxBytes`),
  };
}

/** One `page-field` capture: a profile-declared scalar on the target page. */
function parsePageField(value: unknown, label: string): PageFieldCaptureV2 {
  const node = record(value, label);
  exact(node, ["form", "captureId", "field", "inputId", "kind", "provenanceLabel", "mediaType", "maxBytes"]);
  return {
    form: "page-field", captureId: assertSlug(node.captureId), field: assertSlug(node.field),
    ...parseExposure(node, label),
  };
}

/** One `artifact-deref` capture: a hash-pinned single-body artifact field. */
function parseArtifactDeref(value: unknown, label: string): ArtifactDerefCaptureV2 {
  const node = record(value, label);
  exact(node, ["form", "captureId", "refField", "artifactType", "inputId", "kind", "provenanceLabel", "mediaType", "maxBytes"]);
  return {
    form: "artifact-deref", captureId: assertSlug(node.captureId),
    refField: assertSlug(node.refField), artifactType: assertSlug(node.artifactType),
    ...parseExposure(node, label),
  };
}

/** One `relation-target` capture: exact-one outgoing traversal, then fields. */
function parseRelationTarget(value: unknown, label: string): RelationTargetCaptureV2 {
  const node = record(value, label);
  exact(node, ["form", "captureId", "relationType", "sourceRole", "targetEntityType", "then"]);
  if (node.sourceRole !== "from") {
    throw new PackParseError(`${label}.sourceRole must be "from" — traversal is outgoing directed only`);
  }
  return {
    form: "relation-target", captureId: assertSlug(node.captureId),
    relationType: assertSlug(node.relationType), sourceRole: "from",
    targetEntityType: assertSlug(node.targetEntityType),
    then: array(node.then, `${label}.then`, 8).map((entry, index) => parsePageField(entry, `${label}.then[${index}]`)),
  };
}

/** One `run-binding` capture: an authenticated preparation run's frozen state. */
function parseRunBinding(value: unknown, label: string): RunBindingCaptureV2 {
  const node = record(value, label);
  exact(node, ["form", "captureId", "runIdFrom", "expect", "frozenFields", "outputs"]);
  const expect = record(node.expect, `${label}.expect`);
  exact(expect, ["actionId", "state", "slugField"]);
  if (expect.state !== "succeeded") {
    throw new PackParseError(`${label}.expect.state must be "succeeded"`);
  }
  if (typeof expect.actionId !== "string" || expect.actionId.length === 0) {
    throw new PackParseError(`${label}.expect.actionId must be a non-empty action id`);
  }
  return {
    form: "run-binding", captureId: assertSlug(node.captureId), runIdFrom: assertSlug(node.runIdFrom),
    expect: { actionId: expect.actionId, state: "succeeded", slugField: assertSlug(expect.slugField) },
    frozenFields: array(node.frozenFields, `${label}.frozenFields`, 8).map((entry, index) => {
      const field = record(entry, `${label}.frozenFields[${index}]`);
      exact(field, ["captureId", "field", "inputId", "kind", "provenanceLabel", "mediaType", "maxBytes"]);
      return {
        captureId: assertSlug(field.captureId), field: assertSlug(field.field),
        ...parseExposure(field, `${label}.frozenFields[${index}]`),
      };
    }),
    outputs: array(node.outputs, `${label}.outputs`, 8).map((entry, index) => {
      const output = record(entry, `${label}.outputs[${index}]`);
      exact(output, ["captureId", "logicalPhaseId", "refKind", "refProvenanceLabel",
        "inputId", "kind", "provenanceLabel", "mediaType", "maxBytes"]);
      return {
        captureId: assertSlug(output.captureId), logicalPhaseId: assertSlug(output.logicalPhaseId),
        refKind: assertSlug(output.refKind), refProvenanceLabel: assertSlug(output.refProvenanceLabel),
        ...parseExposure(output, `${label}.outputs[${index}]`),
      };
    }),
  };
}

/** Dispatch one capture on its `form` discriminant. */
function parseCapture(value: unknown, label: string): PageEvidenceCaptureV2 {
  const form = record(value, label).form;
  if (form === "page-field") return parsePageField(value, label);
  if (form === "artifact-deref") return parseArtifactDeref(value, label);
  if (form === "relation-target") return parseRelationTarget(value, label);
  if (form === "run-binding") return parseRunBinding(value, label);
  throw new PackParseError(`${label}.form is not one of the four capture forms`);
}

/**
 * Every exposure-bearing (materializing) node the captures own, nested forms
 * flattened — each carries its captureId and the inputId the host materializes
 * it under. relation-target and run-binding are CONTAINERS: their own captureId
 * names no materialized input, so only their leaves (then / frozenFields+outputs)
 * appear. Shared with the compiler's lowering boundary so the two guards cannot
 * enumerate a different set.
 */
export function flattenPageEvidenceExposures(
  captures: readonly PageEvidenceCaptureV2[],
): ReadonlyArray<{ readonly captureId: string; readonly inputId: string }> {
  const pick = (node: { captureId: string; inputId: string }) => ({ captureId: node.captureId, inputId: node.inputId });
  return captures.flatMap((capture) => {
    if (capture.form === "relation-target") return capture.then.map(pick);
    if (capture.form === "run-binding") return [...capture.frozenFields, ...capture.outputs].map(pick);
    return [pick(capture)];
  });
}

/** Every captureId a descriptor owns, nested forms included. */
function captureIds(captures: readonly PageEvidenceCaptureV2[]): string[] {
  return captures.flatMap((capture) => {
    if (capture.form === "relation-target") return [capture.captureId, ...capture.then.map((then) => then.captureId)];
    if (capture.form === "run-binding") {
      return [capture.captureId, ...capture.frozenFields.map((field) => field.captureId),
        ...capture.outputs.map((output) => output.captureId)];
    }
    return [capture.captureId];
  });
}

/**
 * The sealed page-evidence descriptor: closed target, at least one capture,
 * and PAIRWISE-DISTINCT capture ids — two captures sharing an id would seal
 * one value under the other's keys while every per-capture check still passed.
 */
export function parsePageEvidenceDescriptor(value: unknown, label: string): PageEvidenceDescriptorV2 {
  const node = record(value, label);
  exact(node, ["pathTableKey", "target", "captures"]);
  const target = record(node.target, `${label}.target`);
  exact(target, ["entityType", "slugField"]);
  const captures = array(node.captures, `${label}.captures`, 8)
    .map((entry, index) => parseCapture(entry, `${label}.captures[${index}]`));
  if (captures.length === 0) throw new PackParseError(`${label}.captures is empty`);
  const ids = captureIds(captures);
  if (new Set(ids).size !== ids.length) {
    throw new PackParseError(`${label} repeats a captureId; the derived-key namespaces must be pairwise distinct`);
  }
  const inputIds = flattenPageEvidenceExposures(captures).map((exposure) => exposure.inputId);
  if (new Set(inputIds).size !== inputIds.length) {
    throw new PackParseError(`${label} repeats a materialized inputId; the provider inputs must be pairwise distinct`);
  }
  return {
    pathTableKey: assertSlug(node.pathTableKey),
    target: { entityType: assertSlug(target.entityType), slugField: assertSlug(target.slugField) },
    captures,
  };
}
