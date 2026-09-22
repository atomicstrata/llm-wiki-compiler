/**
 * @file src/preparations/plan-parse-helpers.ts
 * @description Exact-shape field readers and phase-level parsers for the closed
 * normalized preparation plan grammar. Every reader rebuilds a fresh value and
 * names each field explicitly; untrusted input is never spread into a result.
 * Bounded scalar readers are reused from the Milestone A manifest primitives,
 * and digests are branded through the repository's shared `parseSha256Digest`.
 */

import { parsePageEvidenceDescriptor } from "../operations-packs/parse-page-evidence.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import { isValidMediaType } from "../capability-providers/authority/exposure.js";
import {
  array, booleanValue, count, enumValue, exact, record, textValue, type JsonRecord,
} from "../operation-bundles/manifest-values.js";
import { assertSafeComponent } from "./ids.js";
import {
  MAX_ATTEMPTS_PER_PHASE_INSTANCE, MAX_LOGICAL_PHASES_PER_PLAN,
  MAX_PHASE_INSTANCES_PER_RUN,
} from "./constants.js";
import { PreparationPlanError } from "./problems.js";
import { RESERVED_PROVIDER_INPUT_KEYS } from "./plan-types.js";
import type { PlanPageEvidenceDescriptorV1, PlanArtifactEvidenceDescriptorV1,
  ExpansionDeficitDisposition, NormalizedPhaseV1, PhaseBoundsV1, PhaseExecutorV1,
  PhaseExpansionV1, PhaseGateContractV1, PhaseInputBindingV1, PhaseOutputFieldV1, PhaseRole,
  PlanSourceEvidenceDescriptorV1, RepeatContinuationV1,
} from "./plan-types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

const GATE_KINDS = [
  "confirm-input-exposure", "confirm-cost", "confirm-external-effect",
  "confirm-residual-risk", "review-selection", "review-preparation",
  "discussion-checkpoint", "confirm-abandonment",
] as const;
const SENSITIVITIES = ["ordinary", "private", "restricted"] as const;
const RETENTIONS = ["until-handoff", "audit", "checkpoint", "terminal-only"] as const;

/** Brand one canonical sha256 digest field with contextual rejection text. */
export function digestField(value: unknown, label: string): Sha256Digest {
  try {
    return parseSha256Digest(value);
  } catch {
    throw new PreparationPlanError(`${label} must be a canonical sha256 digest`);
  }
}

/** Validate one interpolated safe path/identity component with field context. */
export function component(value: unknown, label: string): string {
  try {
    return assertSafeComponent(value);
  } catch {
    throw new PreparationPlanError(`${label} is not a safe component`);
  }
}

/** Read one required positive count within an inclusive ceiling. */
function boundedPositive(value: unknown, label: string, ceiling: number): number {
  const parsed = count(value, label);
  if (parsed < 1 || parsed > ceiling) throw new PreparationPlanError(`${label} is out of range`);
  return parsed;
}

/** Parse one bounded, unique list of safe component identifiers. */
export function componentList(value: unknown, label: string, maximum: number): string[] {
  const items = array(value, label, maximum).map((item) => component(item, label));
  if (new Set(items).size !== items.length) throw new PreparationPlanError(`${label} has duplicates`);
  return items;
}

/** Parse one immutable content-addressed evidence reference (design 11.3). */
export function evidenceRef(value: unknown, label: string): EvidenceRefV1 {
  const obj = record(value, label);
  exact(obj, ["kind", "mediaType", "provenanceLabel", "digest", "byteCount",
    "sensitivity", "retention", "producer", "untrusted"]);
  if (obj.untrusted !== true) throw new PreparationPlanError(`${label}.untrusted must be true`);
  return {
    kind: textValue(obj.kind, `${label}.kind`), mediaType: textValue(obj.mediaType, `${label}.mediaType`),
    provenanceLabel: textValue(obj.provenanceLabel, `${label}.provenanceLabel`),
    digest: digestField(obj.digest, `${label}.digest`), byteCount: count(obj.byteCount, `${label}.byteCount`),
    sensitivity: enumValue(obj.sensitivity, SENSITIVITIES, `${label}.sensitivity`),
    retention: enumValue(obj.retention, RETENTIONS, `${label}.retention`),
    producer: evidenceProducer(obj.producer, `${label}.producer`), untrusted: true,
  };
}

/** Parse the closed evidence producer union without trusting a caller id. */
function evidenceProducer(value: unknown, label: string): EvidenceRefV1["producer"] {
  const obj = record(value, label);
  if (obj.kind === "host") {
    exact(obj, ["kind", "contractDigest"]);
    return { kind: "host", contractDigest: digestField(obj.contractDigest, `${label}.contractDigest`) };
  }
  if (obj.kind === "provider") {
    exact(obj, ["kind", "providerPinDigest", "attemptId"]);
    return { kind: "provider", providerPinDigest: digestField(obj.providerPinDigest, `${label}.providerPinDigest`),
      attemptId: textValue(obj.attemptId, `${label}.attemptId`) };
  }
  if (obj.kind === "broker") {
    exact(obj, ["kind", "brokerId", "requestId"]);
    return { kind: "broker", brokerId: component(obj.brokerId, `${label}.brokerId`),
      requestId: textValue(obj.requestId, `${label}.requestId`) };
  }
  throw new PreparationPlanError(`${label}.kind is unsupported`);
}

/** Return the exact required and optional key sets for one phase role. */
function phaseKeys(role: PhaseRole): { required: string[]; optional: string[] } {
  const common = ["logicalPhaseId", "role", "dependsOn", "disposition", "inputBindings", "expansion", "bounds"];
  if (role === "work") {
    return { required: [...common, "executor"], optional: ["outputSchemaDigest", "brokerPlanDigest", "effectPlanDigest"] };
  }
  if (role === "gate") return { required: [...common, "gate"], optional: ["outputSchemaDigest"] };
  return { required: common, optional: ["outputSchemaDigest"] };
}

/** Parse one normalized phase, dispatching optional fields by validated role. */
export function parsePhase(value: unknown, index: number): NormalizedPhaseV1 {
  const obj = record(value, `phases[${index}]`);
  const role = enumValue(obj.role, ["work", "gate", "join"] as const, `phases[${index}].role`);
  const keys = phaseKeys(role);
  exact(obj, keys.required, keys.optional);
  const base: NormalizedPhaseV1 = {
    logicalPhaseId: component(obj.logicalPhaseId, `phases[${index}].logicalPhaseId`), role,
    dependsOn: componentList(obj.dependsOn, `phases[${index}].dependsOn`, MAX_LOGICAL_PHASES_PER_PLAN),
    disposition: enumValue(obj.disposition, ["required", "optional"] as const, `phases[${index}].disposition`),
    inputBindings: parseInputBindings(obj.inputBindings, index),
    expansion: parseExpansion(obj.expansion, index), bounds: parsePhaseBounds(obj.bounds, index),
  };
  return withPhaseOptions(obj, base, role, index);
}

/** Attach the role-legal optional executor, gate, digests to a parsed phase. */
function withPhaseOptions(obj: JsonRecord, base: NormalizedPhaseV1, role: PhaseRole, index: number): NormalizedPhaseV1 {
  const outputSchemaDigest = obj.outputSchemaDigest === undefined
    ? undefined : digestField(obj.outputSchemaDigest, `phases[${index}].outputSchemaDigest`);
  const result: NormalizedPhaseV1 = { ...base,
    ...(outputSchemaDigest === undefined ? {} : { outputSchemaDigest }) };
  if (role === "gate") return { ...result, gate: parseGate(obj.gate, index) };
  if (role !== "work") return result;
  return { ...result, executor: parseExecutor(obj.executor, index),
    ...(obj.brokerPlanDigest === undefined ? {} : { brokerPlanDigest: digestField(obj.brokerPlanDigest, `phases[${index}].brokerPlanDigest`) }),
    ...(obj.effectPlanDigest === undefined ? {} : { effectPlanDigest: digestField(obj.effectPlanDigest, `phases[${index}].effectPlanDigest`) }) };
}

/** Parse one bounded list of input bindings without a spread of caller data. */
function parseInputBindings(value: unknown, index: number): PhaseInputBindingV1[] {
  const items = array(value, `phases[${index}].inputBindings`, MAX_LOGICAL_PHASES_PER_PLAN);
  const bindings = items.map((item, position) => parseInputBinding(item, index, position));
  if (new Set(bindings.map((item) => item.bindingId)).size !== bindings.length) {
    throw new PreparationPlanError(`phases[${index}].inputBindings has duplicate binding ids`);
  }
  return bindings;
}

/** Parse one phase input binding: the frozen initial set or a predecessor output. */
function parseInputBinding(value: unknown, index: number, position: number): PhaseInputBindingV1 {
  const label = `phases[${index}].inputBindings[${position}]`;
  const obj = record(value, label);
  exact(obj, ["bindingId", "sourceKind"], ["sourcePhaseId"]);
  const sourceKind = enumValue(obj.sourceKind, ["initial-input", "phase-output"] as const, `${label}.sourceKind`);
  const sourcePhaseId = obj.sourcePhaseId === undefined ? undefined : component(obj.sourcePhaseId, `${label}.sourcePhaseId`);
  if ((sourceKind === "phase-output") !== (sourcePhaseId !== undefined)) {
    throw new PreparationPlanError(`${label} phase-output binding requires exactly one sourcePhaseId`);
  }
  return { bindingId: component(obj.bindingId, `${label}.bindingId`), sourceKind,
    ...(sourcePhaseId === undefined ? {} : { sourcePhaseId }) };
}

/** Parse a provider phase's sealed output contract without spreading caller data. */
function parseOutputSchema(value: unknown, label: string): PhaseOutputFieldV1[] {
  const items = array(value, label, MAX_LOGICAL_PHASES_PER_PLAN);
  return items.map((item, position) => {
    const field = record(item, `${label}[${position}]`);
    exact(field, ["fieldId", "valueKind"]);
    return {
      fieldId: component(field.fieldId, `${label}[${position}].fieldId`),
      valueKind: textValue(field.valueKind, `${label}[${position}].valueKind`),
    };
  });
}

/**
 * The pack grammar's slug rule, restated for the untrusted plan surface
 * (operations-packs/ids.ts SLUG_ID; the layering runs operations-packs →
 * preparations, so the rule cannot be imported without a cycle): lowercase
 * kebab, at most 96 bytes. Descriptor names minted into provider input ids
 * must satisfy it HERE, not fail later at materialization.
 */
const PLAN_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PLAN_SLUG_BYTES = 96;

/** A slug-constrained descriptor field: the same shape the pack grammar seals. */
function slugField(value: unknown, label: string): string {
  const parsed = component(value, label);
  if (!PLAN_SLUG.test(parsed) || Buffer.byteLength(parsed, "utf8") > MAX_PLAN_SLUG_BYTES) {
    throw new PreparationPlanError(`${label} is not a slug`);
  }
  return parsed;
}

/** A syntactic `type/subtype` media type — the same grammar invocation enforces. */
function planMediaType(value: unknown, label: string): string {
  const parsed = textValue(value, `${label}.mediaType`, 128);
  if (!isValidMediaType(parsed)) {
    throw new PreparationPlanError(`${label}.mediaType is not a media type`);
  }
  return parsed;
}

/** A required count that must be at least one — the pack grammar's positiveCount. */
function positiveCountField(value: unknown, label: string): number {
  const parsed = count(value, label);
  if (parsed < 1) throw new PreparationPlanError(`${label} must be at least one`);
  return parsed;
}

/** A plan path-table key: a safe component that is not a reserved provider input key. */
function pathTableKeyField(value: unknown, label: string): string {
  const key = slugField(value, `${label}.pathTableKey`);
  if (RESERVED_PROVIDER_INPUT_KEYS.has(key)) {
    throw new PreparationPlanError(`${label}.pathTableKey may not take the reserved input key: ${key}`);
  }
  return key;
}

/** Refuse aliased descriptor columns: one input field cannot claim two roles. */
function assertDistinctFields(fields: Readonly<Record<string, string>>, label: string): void {
  if (new Set(Object.values(fields)).size !== Object.keys(fields).length) {
    throw new PreparationPlanError(`${label} names the same input field for two roles: ${Object.values(fields).join("/")}`);
  }
}

/**
 * Parse the sealed source-evidence descriptor. OPTIONAL on the executor: every
 * plan written before this field existed parses unchanged and resolves to no
 * source-evidence inputs — the behaviour it was approved under. No migration,
 * no version bump, no dual-read path.
 */
function parseSourceEvidenceDescriptor(value: unknown, label: string): PlanSourceEvidenceDescriptorV1 {
  const obj = record(value, label);
  exact(obj, [
    "pathsField", "digestsField", "byteCountsField", "inputIdPrefix",
    "kind", "provenanceLabel", "mediaType", "maxItems", "maxBytes", "pathTableKey",
  ]);
  const fields = {
    pathsField: slugField(obj.pathsField, `${label}.pathsField`),
    digestsField: slugField(obj.digestsField, `${label}.digestsField`),
    byteCountsField: slugField(obj.byteCountsField, `${label}.byteCountsField`),
  };
  assertDistinctFields(fields, label);
  return {
    ...fields,
    inputIdPrefix: slugField(obj.inputIdPrefix, `${label}.inputIdPrefix`),
    kind: slugField(obj.kind, `${label}.kind`),
    provenanceLabel: slugField(obj.provenanceLabel, `${label}.provenanceLabel`),
    mediaType: planMediaType(obj.mediaType, label),
    maxItems: positiveCountField(obj.maxItems, `${label}.maxItems`),
    maxBytes: positiveCountField(obj.maxBytes, `${label}.maxBytes`),
    pathTableKey: pathTableKeyField(obj.pathTableKey, label),
  };
}

/** Parse one plan-sealed artifact-evidence descriptor (AS-4 P4.2), field by field. */
function parseArtifactEvidenceDescriptor(value: unknown, label: string): PlanArtifactEvidenceDescriptorV1 {
  const obj = record(value, label);
  exact(obj, [
    "refField", "memberNamesField", "memberDigestsField", "memberByteCountsField", "inputIdPrefix",
    "kind", "provenanceLabel", "mediaType", "maxItems", "maxBytes", "pathTableKey",
  ]);
  const fields = {
    refField: slugField(obj.refField, `${label}.refField`),
    memberNamesField: slugField(obj.memberNamesField, `${label}.memberNamesField`),
    memberDigestsField: slugField(obj.memberDigestsField, `${label}.memberDigestsField`),
    memberByteCountsField: slugField(obj.memberByteCountsField, `${label}.memberByteCountsField`),
  };
  assertDistinctFields(fields, label);
  return {
    ...fields,
    inputIdPrefix: slugField(obj.inputIdPrefix, `${label}.inputIdPrefix`),
    kind: slugField(obj.kind, `${label}.kind`),
    provenanceLabel: slugField(obj.provenanceLabel, `${label}.provenanceLabel`),
    mediaType: planMediaType(obj.mediaType, label),
    maxItems: positiveCountField(obj.maxItems, `${label}.maxItems`),
    maxBytes: positiveCountField(obj.maxBytes, `${label}.maxBytes`),
    pathTableKey: pathTableKeyField(obj.pathTableKey, label),
  };
}

/** Parse one pinned provider-capability executor, with at most ONE evidence kind. */
function parseProviderCapabilityExecutor(obj: Record<string, unknown>, label: string): PhaseExecutorV1 {
  exact(obj, ["kind", "providerPinDigest", "capabilityId", "capabilityContractDigest"],
    ["outputSchema", "maximumOutputItems", "requestTemplateRef", "sourceEvidenceDescriptor", "artifactEvidenceDescriptor", "pageEvidenceDescriptor"]);
  // ONE evidence kind per executor — the same refusal the compiler seals
  // under: with both, authority resolution would hash one builder's specs
  // while the leg materializes the other's.
  const evidenceKinds = [obj.sourceEvidenceDescriptor, obj.artifactEvidenceDescriptor, obj.pageEvidenceDescriptor]
    .filter((declared) => declared !== undefined).length;
  if (evidenceKinds > 1) {
    throw new PreparationPlanError(`${label} declares ${evidenceKinds} evidence descriptors; an executor may carry at most one`);
  }
  return { kind: "provider-capability", providerPinDigest: digestField(obj.providerPinDigest, `${label}.providerPinDigest`),
    capabilityId: component(obj.capabilityId, `${label}.capabilityId`),
    capabilityContractDigest: digestField(obj.capabilityContractDigest, `${label}.capabilityContractDigest`),
    ...(obj.outputSchema === undefined ? {} : { outputSchema: parseOutputSchema(obj.outputSchema, `${label}.outputSchema`) }),
    ...(obj.maximumOutputItems === undefined ? {} : { maximumOutputItems: count(obj.maximumOutputItems, `${label}.maximumOutputItems`) }),
    ...(obj.requestTemplateRef === undefined ? {} : { requestTemplateRef: textValue(obj.requestTemplateRef, `${label}.requestTemplateRef`) }),
    ...(obj.sourceEvidenceDescriptor === undefined ? {} : {
      sourceEvidenceDescriptor: parseSourceEvidenceDescriptor(obj.sourceEvidenceDescriptor, `${label}.sourceEvidenceDescriptor`),
    }),
    ...(obj.artifactEvidenceDescriptor === undefined ? {} : {
      artifactEvidenceDescriptor: parseArtifactEvidenceDescriptor(obj.artifactEvidenceDescriptor, `${label}.artifactEvidenceDescriptor`),
    }),
    ...(obj.pageEvidenceDescriptor === undefined ? {} : {
      pageEvidenceDescriptor: parsePlanPageEvidence(obj.pageEvidenceDescriptor, `${label}.pageEvidenceDescriptor`),
    }) };
}

/** The plan-side page-evidence parse: the ONE pack grammar, plan-typed errors. */
function parsePlanPageEvidence(value: unknown, label: string): PlanPageEvidenceDescriptorV1 {
  try {
    return parsePageEvidenceDescriptor(value, label);
  } catch (error) {
    throw new PreparationPlanError((error as Error).message);
  }
}

/** Parse one pinned provider-capability or host-handler executor. */
function parseExecutor(value: unknown, index: number): PhaseExecutorV1 {
  const label = `phases[${index}].executor`;
  const obj = record(value, label);
  if (obj.kind === "provider-capability") return parseProviderCapabilityExecutor(obj, label);
  if (obj.kind === "host-handler") {
    exact(obj, ["kind", "handlerId", "handlerContractVersion", "handlerContractDigest"]);
    return { kind: "host-handler", handlerId: component(obj.handlerId, `${label}.handlerId`),
      handlerContractVersion: textValue(obj.handlerContractVersion, `${label}.handlerContractVersion`),
      handlerContractDigest: digestField(obj.handlerContractDigest, `${label}.handlerContractDigest`) };
  }
  throw new PreparationPlanError(`${label}.kind is unsupported`);
}

/** Parse one closed host gate contract. */
function parseGate(value: unknown, index: number): PhaseGateContractV1 {
  const label = `phases[${index}].gate`;
  const obj = record(value, label);
  exact(obj, ["gateId", "gateKind"]);
  return { gateId: component(obj.gateId, `${label}.gateId`), gateKind: enumValue(obj.gateKind, GATE_KINDS, `${label}.gateKind`) };
}

/** Parse the closed expansion policy union (design section 10.3). */
function parseExpansion(value: unknown, index: number): PhaseExpansionV1 {
  const label = `phases[${index}].expansion`;
  const obj = record(value, label);
  if (obj.kind === "single") {
    exact(obj, ["kind"]);
    return { kind: "single" };
  }
  if (obj.kind === "map") return parseMapExpansion(obj, label);
  if (obj.kind === "bounded-repeat") return parseRepeatExpansion(obj, label);
  throw new PreparationPlanError(`${label}.kind is unsupported`);
}

/** Parse one bounded map expansion with an explicit overflow disposition. */
function parseMapExpansion(obj: JsonRecord, label: string): PhaseExpansionV1 {
  exact(obj, ["kind", "sourceEvidenceBinding", "maximumItems", "itemIdentity", "duplicateDisposition", "overflowDisposition"]);
  return { kind: "map", sourceEvidenceBinding: component(obj.sourceEvidenceBinding, `${label}.sourceEvidenceBinding`),
    maximumItems: boundedPositive(obj.maximumItems, `${label}.maximumItems`, MAX_PHASE_INSTANCES_PER_RUN),
    itemIdentity: enumValue(obj.itemIdentity, ["host-id", "canonical-item-digest"] as const, `${label}.itemIdentity`),
    duplicateDisposition: enumValue(obj.duplicateDisposition, ["deduplicate", "fail"] as const, `${label}.duplicateDisposition`),
    overflowDisposition: parseDeficitDisposition(obj.overflowDisposition, `${label}.overflowDisposition`) };
}

/** Parse one bounded-repeat expansion with a single closed continuation rule. */
function parseRepeatExpansion(obj: JsonRecord, label: string): PhaseExpansionV1 {
  exact(obj, ["kind", "maximumIterations", "continuation", "limitDisposition"]);
  const maximumIterations = boundedPositive(obj.maximumIterations, `${label}.maximumIterations`, MAX_PHASE_INSTANCES_PER_RUN);
  return { kind: "bounded-repeat", maximumIterations,
    continuation: parseContinuation(obj.continuation, `${label}.continuation`, maximumIterations),
    limitDisposition: parseDeficitDisposition(obj.limitDisposition, `${label}.limitDisposition`) };
}

/** Parse the one declared continuation rule; a fixed count over the max is an error. */
function parseContinuation(value: unknown, label: string, maximumIterations: number): RepeatContinuationV1 {
  const obj = record(value, label);
  if (obj.kind === "fixed-count") {
    exact(obj, ["kind", "count"]);
    const fixed = count(obj.count, `${label}.count`);
    if (fixed > maximumIterations) throw new PreparationPlanError(`${label}.count exceeds maximumIterations`);
    return { kind: "fixed-count", count: fixed };
  }
  if (obj.kind === "until-empty") {
    exact(obj, ["kind", "outputField"]);
    return { kind: "until-empty", outputField: component(obj.outputField, `${label}.outputField`) };
  }
  if (obj.kind === "while-boolean") {
    exact(obj, ["kind", "outputField", "continueValue"]);
    return { kind: "while-boolean", outputField: component(obj.outputField, `${label}.outputField`),
      continueValue: booleanValue(obj.continueValue, `${label}.continueValue`) };
  }
  throw new PreparationPlanError(`${label}.kind is unsupported`);
}

/** Parse one fail-closed or count-as-incomplete deficit disposition. */
function parseDeficitDisposition(value: unknown, label: string): ExpansionDeficitDisposition {
  const obj = record(value, label);
  if (obj.kind === "fail-closed") {
    exact(obj, ["kind"]);
    return { kind: "fail-closed" };
  }
  if (obj.kind === "count-as-incomplete") {
    exact(obj, ["kind", "completenessClassId"]);
    return { kind: "count-as-incomplete", completenessClassId: component(obj.completenessClassId, `${label}.completenessClassId`) };
  }
  throw new PreparationPlanError(`${label}.kind is unsupported`);
}

/** Parse the declared per-instance worst-case phase bounds. */
function parsePhaseBounds(value: unknown, index: number): PhaseBoundsV1 {
  const label = `phases[${index}].bounds`;
  const obj = record(value, label);
  exact(obj, ["maximumAttempts", "maximumInvocationsPerAttempt", "maximumBrokerRequestsPerAttempt",
    "maximumEffectsPerAttempt", "maximumTransitionsPerInstance", "maximumOutputEvidenceBytes",
    "maximumCheckpointBytes", "maximumTokensPerAttempt", "maximumTimeMsPerInstance", "maximumCostMicrosPerAttempt"]);
  return {
    maximumAttempts: boundedPositive(obj.maximumAttempts, `${label}.maximumAttempts`, MAX_ATTEMPTS_PER_PHASE_INSTANCE),
    maximumInvocationsPerAttempt: count(obj.maximumInvocationsPerAttempt, `${label}.maximumInvocationsPerAttempt`),
    maximumBrokerRequestsPerAttempt: count(obj.maximumBrokerRequestsPerAttempt, `${label}.maximumBrokerRequestsPerAttempt`),
    maximumEffectsPerAttempt: count(obj.maximumEffectsPerAttempt, `${label}.maximumEffectsPerAttempt`),
    maximumTransitionsPerInstance: count(obj.maximumTransitionsPerInstance, `${label}.maximumTransitionsPerInstance`),
    maximumOutputEvidenceBytes: count(obj.maximumOutputEvidenceBytes, `${label}.maximumOutputEvidenceBytes`),
    maximumCheckpointBytes: count(obj.maximumCheckpointBytes, `${label}.maximumCheckpointBytes`),
    maximumTokensPerAttempt: count(obj.maximumTokensPerAttempt, `${label}.maximumTokensPerAttempt`),
    maximumTimeMsPerInstance: count(obj.maximumTimeMsPerInstance, `${label}.maximumTimeMsPerInstance`),
    maximumCostMicrosPerAttempt: count(obj.maximumCostMicrosPerAttempt, `${label}.maximumCostMicrosPerAttempt`),
  };
}

/**
 * The plan-wide evidence discipline the compiler seals under (one descriptor
 * of each kind per ACTION — a plan is one action — and pairwise-distinct
 * claimed action-input fields): a later host capture would OVERWRITE an
 * earlier one's columns if two descriptors claimed one field, and the length
 * checks alone would never notice.
 */
export function assertEvidenceDescriptorDiscipline(phases: readonly NormalizedPhaseV1[]): void {
  const claimed: string[] = [];
  let sourceCount = 0;
  let artifactCount = 0;
  for (const phase of phases) {
    const executor = phase.executor;
    if (executor?.kind !== "provider-capability") continue;
    const source = executor.sourceEvidenceDescriptor;
    if (source !== undefined) {
      sourceCount += 1;
      claimed.push(source.pathsField, source.digestsField, source.byteCountsField);
    }
    const artifact = executor.artifactEvidenceDescriptor;
    if (artifact !== undefined) {
      artifactCount += 1;
      claimed.push(artifact.refField, artifact.memberNamesField, artifact.memberDigestsField, artifact.memberByteCountsField);
    }
  }
  if (sourceCount > 1 || artifactCount > 1) {
    throw new PreparationPlanError(
      `${sourceCount + artifactCount} evidence descriptors of one kind across the plan; each kind may appear at most once`);
  }
  if (new Set(claimed).size !== claimed.length) {
    throw new PreparationPlanError(`evidence descriptors claim the same action-input field twice: ${claimed.join("/")}`);
  }
}
