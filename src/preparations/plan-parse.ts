/**
 * @file src/preparations/plan-parse.ts
 * @description Bounded, duplicate-key-free loader for the closed version-one
 * normalized preparation plan (design sections 10.1 and 10.4). It rebuilds a
 * fresh allowlisted plan through the repository's sole RFC 8785 canonical
 * digest implementation, then runs closed graph validation and worst-case
 * bounds arithmetic before the plan is trusted. Nothing is spread from the
 * untrusted document; every field is named and rebuilt.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import {
  array, count, enumValue, exact, record, textValue, unique, type JsonRecord,
} from "../operation-bundles/manifest-values.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import {
  MAX_LOGICAL_PHASES_PER_PLAN, MAX_PLAN_BYTES, MAX_PLAN_JSON_DEPTH,
  MILESTONE_A_DESIGN_DIGEST, PREPARATION_SCHEMA_VERSION,
} from "./constants.js";
import { assertPreparationId } from "./ids.js";
import { assertPreparationBounds } from "./plan-bounds.js";
import { validatePreparationPlanGraph } from "./plan-graph.js";
import {
  assertEvidenceDescriptorDiscipline, component, componentList, digestField, evidenceRef, parsePhase,
} from "./plan-parse-helpers.js";
import { PreparationPlanError } from "./problems.js";
import type {
  HandoffCapacityPlanV1, HandoffEvidenceClassV1, NormalizedPreparationPlanV1,
  PreparationBoundsV1, PreparationOutputContractV1,
} from "./plan-types.js";
import type {
  ActionAuthorityRefV1, AuthorityRefV1, Sha256Digest, WorkflowParentRefV1,
} from "./types.js";

const TOP_KEYS = ["schemaVersion", "executionMode", "atomicityClass", "workspaceId",
  "knowledgeAuthority", "operationsAuthority", "actionAuthority", "recipeDigest",
  "initialInputSet", "phases", "outputContract", "bounds", "safetyFloorDigest"] as const;
const TOP_OPTIONAL = ["workflowParent", "supersedesPreparationId"] as const;

/** Return the plan's canonical digest from the shared RFC 8785 canonicalizer. */
export function preparationPlanDigest(plan: NormalizedPreparationPlanV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest(plan));
}

/** Recompute the plan digest and reject any disagreement (design section 13.1). */
export function verifyPreparationPlanDigest(
  plan: NormalizedPreparationPlanV1,
  expected: string,
): Sha256Digest {
  const recomputed = preparationPlanDigest(plan);
  if (recomputed !== expected) throw new PreparationPlanError("plan digest does not match its recomputation");
  return recomputed;
}

/** Parse, rebuild, and fully validate one version-one plan from bounded JSON. */
export function parsePreparationPlan(text: string): NormalizedPreparationPlanV1 {
  const root = record(parseBoundedUniqueJson(text, MAX_PLAN_BYTES, MAX_PLAN_JSON_DEPTH), "plan");
  exact(root, TOP_KEYS, TOP_OPTIONAL);
  if (root.schemaVersion !== PREPARATION_SCHEMA_VERSION) {
    throw new PreparationPlanError("plan schemaVersion must be 1");
  }
  const plan = assemblePlan(root);
  validatePreparationPlanGraph(plan);
  assertPreparationBounds(plan);
  return plan;
}

/** Rebuild the fresh plan object field by field before semantic validation. */
function assemblePlan(root: JsonRecord): NormalizedPreparationPlanV1 {
  const phases = unique(
    array(root.phases, "phases", MAX_LOGICAL_PHASES_PER_PLAN).map(parsePhase),
    "logicalPhaseId", "phases",
  );
  assertEvidenceDescriptorDiscipline(phases);
  const base: NormalizedPreparationPlanV1 = {
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    executionMode: enumValue(root.executionMode, ["ephemeral-read", "durable-preparation"] as const, "executionMode"),
    atomicityClass: enumValue(root.atomicityClass,
      ["local-bundle-only", "external-effect-only", "non-atomic-external-before-local"] as const, "atomicityClass"),
    workspaceId: component(root.workspaceId, "workspaceId"),
    knowledgeAuthority: parseAuthority(root.knowledgeAuthority, "knowledgeAuthority"),
    operationsAuthority: parseAuthority(root.operationsAuthority, "operationsAuthority"),
    actionAuthority: parseActionAuthority(root.actionAuthority),
    recipeDigest: digestField(root.recipeDigest, "recipeDigest"),
    initialInputSet: evidenceRef(root.initialInputSet, "initialInputSet"),
    phases, outputContract: parseOutputContract(root.outputContract),
    bounds: parsePreparationBounds(root.bounds),
    safetyFloorDigest: digestField(root.safetyFloorDigest, "safetyFloorDigest"),
  };
  return withPlanOptions(root, base);
}

/** Attach optional workflow-parent and supersession-shape edges when declared. */
function withPlanOptions(root: JsonRecord, base: NormalizedPreparationPlanV1): NormalizedPreparationPlanV1 {
  const workflowParent = root.workflowParent === undefined
    ? undefined : parseWorkflowParent(root.workflowParent);
  const supersedesPreparationId = root.supersedesPreparationId === undefined
    ? undefined : assertPreparationId(root.supersedesPreparationId);
  return { ...base,
    ...(workflowParent === undefined ? {} : { workflowParent }),
    ...(supersedesPreparationId === undefined ? {} : { supersedesPreparationId }) };
}

/** Parse one knowledge-profile or operations-pack authority reference. */
function parseAuthority(value: unknown, label: string): AuthorityRefV1 {
  const obj = record(value, label);
  exact(obj, ["id", "version", "digest", "runtimeIdentityDigest"]);
  return { id: textValue(obj.id, `${label}.id`), version: textValue(obj.version, `${label}.version`),
    digest: digestField(obj.digest, `${label}.digest`),
    runtimeIdentityDigest: digestField(obj.runtimeIdentityDigest, `${label}.runtimeIdentityDigest`) };
}

/** Parse the configured action authority and its capability-class ceiling. */
function parseActionAuthority(value: unknown): ActionAuthorityRefV1 {
  const obj = record(value, "actionAuthority");
  exact(obj, ["actionId", "actionDescriptorDigest", "handlerContractDigest", "requestedSurface", "capabilityClassCeiling"]);
  return { actionId: component(obj.actionId, "actionAuthority.actionId"),
    actionDescriptorDigest: digestField(obj.actionDescriptorDigest, "actionAuthority.actionDescriptorDigest"),
    handlerContractDigest: digestField(obj.handlerContractDigest, "actionAuthority.handlerContractDigest"),
    requestedSurface: textValue(obj.requestedSurface, "actionAuthority.requestedSurface"),
    capabilityClassCeiling: textValue(obj.capabilityClassCeiling, "actionAuthority.capabilityClassCeiling") };
}

/** Parse the one-way outer workflow-parent reference (design section 7.3). */
function parseWorkflowParent(value: unknown): WorkflowParentRefV1 {
  const obj = record(value, "workflowParent");
  exact(obj, ["workflowRunId", "workflowId", "workflowDigest"], ["stageId"]);
  const stageId = obj.stageId === undefined ? undefined : textValue(obj.stageId, "workflowParent.stageId");
  return { workflowRunId: textValue(obj.workflowRunId, "workflowParent.workflowRunId"),
    workflowId: textValue(obj.workflowId, "workflowParent.workflowId"),
    workflowDigest: digestField(obj.workflowDigest, "workflowParent.workflowDigest"),
    ...(stageId === undefined ? {} : { stageId }) };
}

/** Parse the declared output contract and its optional handoff capacity subset. */
function parseOutputContract(value: unknown): PreparationOutputContractV1 {
  const obj = record(value, "outputContract");
  exact(obj, ["producingPhaseIds"], ["handoffCapacity"]);
  const producingPhaseIds = componentList(obj.producingPhaseIds, "outputContract.producingPhaseIds", MAX_LOGICAL_PHASES_PER_PLAN);
  if (producingPhaseIds.length === 0) throw new PreparationPlanError("outputContract.producingPhaseIds must not be empty");
  const handoffCapacity = obj.handoffCapacity === undefined ? undefined : parseHandoffCapacity(obj.handoffCapacity);
  return { producingPhaseIds, ...(handoffCapacity === undefined ? {} : { handoffCapacity }) };
}

/** Parse the closed downstream handoff capacity contract (design section 10.1). */
function parseHandoffCapacity(value: unknown): HandoffCapacityPlanV1 {
  const obj = record(value, "handoffCapacity");
  exact(obj, ["milestoneADesignDigest", "includedEvidenceClasses", "maximumBundlePayloadBytes",
    "maximumManifestBytes", "maximumRunEvidenceItemBytes", "maximumRunEvidenceBytes", "maximumActiveStoreContributionBytes"],
  ["maximumMaterializationManifestBytes", "maximumMaterializationPayloadRefs", "maximumMaterializationPayloadBytes"]);
  if (obj.milestoneADesignDigest !== MILESTONE_A_DESIGN_DIGEST) {
    throw new PreparationPlanError("handoffCapacity.milestoneADesignDigest must pin the exact Milestone A design digest");
  }
  return { milestoneADesignDigest: MILESTONE_A_DESIGN_DIGEST,
    includedEvidenceClasses: unique(array(obj.includedEvidenceClasses, "handoffCapacity.includedEvidenceClasses",
      MAX_LOGICAL_PHASES_PER_PLAN).map(parseEvidenceClass), "classId", "handoffCapacity.includedEvidenceClasses"),
    maximumBundlePayloadBytes: count(obj.maximumBundlePayloadBytes, "handoffCapacity.maximumBundlePayloadBytes"),
    maximumManifestBytes: count(obj.maximumManifestBytes, "handoffCapacity.maximumManifestBytes"),
    maximumRunEvidenceItemBytes: count(obj.maximumRunEvidenceItemBytes, "handoffCapacity.maximumRunEvidenceItemBytes"),
    maximumRunEvidenceBytes: count(obj.maximumRunEvidenceBytes, "handoffCapacity.maximumRunEvidenceBytes"),
    maximumActiveStoreContributionBytes: count(obj.maximumActiveStoreContributionBytes, "handoffCapacity.maximumActiveStoreContributionBytes"),
    ...optionalMaterializationLimits(obj) };
}

/** Parse the optional materialization limits, each only when present. */
function optionalMaterializationLimits(obj: JsonRecord): Partial<HandoffCapacityPlanV1> {
  const parsed = (key: "maximumMaterializationManifestBytes" | "maximumMaterializationPayloadRefs"
    | "maximumMaterializationPayloadBytes") =>
    (obj[key] === undefined ? {} : { [key]: count(obj[key], `handoffCapacity.${key}`) });
  return {
    ...parsed("maximumMaterializationManifestBytes"),
    ...parsed("maximumMaterializationPayloadRefs"),
    ...parsed("maximumMaterializationPayloadBytes"),
  };
}

/** Parse one included handoff evidence class. */
function parseEvidenceClass(value: unknown, index: number): HandoffEvidenceClassV1 {
  const label = `handoffCapacity.includedEvidenceClasses[${index}]`;
  const obj = record(value, label);
  exact(obj, ["classId", "maximumItems", "maximumItemBytes", "maximumAggregateBytes"]);
  return { classId: component(obj.classId, `${label}.classId`), maximumItems: count(obj.maximumItems, `${label}.maximumItems`),
    maximumItemBytes: count(obj.maximumItemBytes, `${label}.maximumItemBytes`),
    maximumAggregateBytes: count(obj.maximumAggregateBytes, `${label}.maximumAggregateBytes`) };
}

/** Parse the declared worst-case run envelope. */
function parsePreparationBounds(value: unknown): PreparationBoundsV1 {
  const obj = record(value, "bounds");
  exact(obj, ["maximumPhaseInstances", "maximumAttempts", "maximumInvocations", "maximumBrokerRequests",
    "maximumEffects", "maximumTransitions", "maximumEvidenceRefs", "maximumEvidenceBytes",
    "maximumCheckpointBytes", "maximumTokens", "maximumTimeMs", "maximumCostMicros"]);
  return { maximumPhaseInstances: count(obj.maximumPhaseInstances, "bounds.maximumPhaseInstances"),
    maximumAttempts: count(obj.maximumAttempts, "bounds.maximumAttempts"),
    maximumInvocations: count(obj.maximumInvocations, "bounds.maximumInvocations"),
    maximumBrokerRequests: count(obj.maximumBrokerRequests, "bounds.maximumBrokerRequests"),
    maximumEffects: count(obj.maximumEffects, "bounds.maximumEffects"),
    maximumTransitions: count(obj.maximumTransitions, "bounds.maximumTransitions"),
    maximumEvidenceRefs: count(obj.maximumEvidenceRefs, "bounds.maximumEvidenceRefs"),
    maximumEvidenceBytes: count(obj.maximumEvidenceBytes, "bounds.maximumEvidenceBytes"),
    maximumCheckpointBytes: count(obj.maximumCheckpointBytes, "bounds.maximumCheckpointBytes"),
    maximumTokens: count(obj.maximumTokens, "bounds.maximumTokens"),
    maximumTimeMs: count(obj.maximumTimeMs, "bounds.maximumTimeMs"),
    maximumCostMicros: count(obj.maximumCostMicros, "bounds.maximumCostMicros") };
}
