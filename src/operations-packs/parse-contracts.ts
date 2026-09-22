/**
 * @file src/operations-packs/parse-contracts.ts
 * @description Parsers for the pack's contract pins (section 10.2), provider
 * requirements (section 13.1, FULL shape), and workspace contract (section 12.1).
 * Section 10.2 and 12.1 are specified in prose; their concrete closed field
 * bindings are declared in `types.ts` and validated here. Design-document digests
 * are compatibility evidence, not code imports, and a provider requirement never
 * resolves a range or installs a provider — it only pins exact allowed digests.
 */

import { array, count, enumValue, exact, record, type JsonRecord } from "../operation-bundles/manifest-values.js";
import { MAX_CLOSED_STRING_SET, MAX_REQUIREMENT_PROVIDER_PINS } from "./constants.js";
import { assertPackDigest, assertRefId, assertRoleId, assertSlug, assertPackVersion } from "./ids.js";
import { PackParseError } from "./problems.js";
import type {
  PackContractRequirementsV2, ProductReadinessDimensionV2, ProviderFallbackPolicyV2,
  ProviderRequestedBoundsV2, ProviderRequirementV2, WorkspaceContractV2,
} from "./types.js";
import { assertUniqueStrings, digestList, positiveCount, refList, slugList } from "./values.js";

const REQUIREMENTS_KEYS = [
  "providerContractDigest", "orchestrationContractDigest", "milestoneAContractDigest",
  "knowledgeProfileSchemaVersion", "operationsPackSchemaVersion",
  "hostHandlerRegistryVersion", "hostHandlerRegistryDigest",
] as const;
const PROVIDER_REQUIRED = [
  "roleId", "disposition", "capabilityId", "capabilityContractDigest",
  "allowedProviderPins", "requiredReadinessDimensions", "requestedGrantKinds", "fallbackPolicy",
] as const;
const PROVIDER_OPTIONAL = ["defaultProviderPin", "requestedBounds"] as const;
const WORKSPACE_KEYS = [
  "workspaceIdentityGrammar", "requiredKnowledgeProfileId", "compatibleKnowledgeProfileDigests",
  "catalogSchemaDependencies", "sourceSchemaDependencies", "allowedContextRootPolicyIds",
  "declaredProjectionClasses", "requiredSettingFields", "requiredProviderCapabilityRoles",
  "supportedImportCompatibilityModes", "productReadinessDimensions",
] as const;

/** Require a positive schema-version integer. */
function schemaVersion(value: unknown, label: string): number {
  const parsed = count(value, label);
  if (parsed < 1) throw new PackParseError(`${label} must be at least one`);
  return parsed;
}

/** Parse the pack's exact contract pins (section 10.2, resolved from prose). */
export function parseContractRequirements(value: unknown, label: string): PackContractRequirementsV2 {
  const node = record(value, label);
  exact(node, REQUIREMENTS_KEYS);
  return {
    providerContractDigest: assertPackDigest(node.providerContractDigest),
    orchestrationContractDigest: assertPackDigest(node.orchestrationContractDigest),
    milestoneAContractDigest: assertPackDigest(node.milestoneAContractDigest),
    knowledgeProfileSchemaVersion: schemaVersion(node.knowledgeProfileSchemaVersion, `${label}.knowledgeProfileSchemaVersion`),
    operationsPackSchemaVersion: schemaVersion(node.operationsPackSchemaVersion, `${label}.operationsPackSchemaVersion`),
    hostHandlerRegistryVersion: assertPackVersion(node.hostHandlerRegistryVersion),
    hostHandlerRegistryDigest: assertPackDigest(node.hostHandlerRegistryDigest),
  };
}

/** Parse the explicit fallback policy of one provider requirement (section 13.1). */
function parseFallbackPolicy(value: unknown, label: string): ProviderFallbackPolicyV2 {
  const node = record(value, label);
  const kind = enumValue(node.kind, ["none", "explicit-ordered"], `${label}.kind`);
  if (kind === "none") {
    exact(node, ["kind"]);
    return { kind };
  }
  exact(node, ["kind", "providerPinDigests"]);
  return { kind, providerPinDigests: digestList(node.providerPinDigests, `${label}.providerPinDigests`, MAX_REQUIREMENT_PROVIDER_PINS) };
}

/** Attach a default provider pin only when it is within the allowed set (section 13.1). */
function withDefaultPin(
  base: ProviderRequirementV2, node: JsonRecord, allowed: readonly string[], label: string,
): ProviderRequirementV2 {
  if (node.defaultProviderPin === undefined) return base;
  const defaultProviderPin = assertPackDigest(node.defaultProviderPin);
  if (!allowed.includes(defaultProviderPin)) throw new PackParseError(`${label} defaultProviderPin is not in allowedProviderPins`);
  return { ...base, defaultProviderPin };
}

/** Parse one provider capability requirement (section 13.1, FULL shape). */
export function parseProviderRequirement(value: unknown, label: string): ProviderRequirementV2 {
  const node = record(value, label);
  exact(node, PROVIDER_REQUIRED, PROVIDER_OPTIONAL);
  const allowedProviderPins = digestList(node.allowedProviderPins, `${label}.allowedProviderPins`, MAX_REQUIREMENT_PROVIDER_PINS);
  const base: ProviderRequirementV2 = {
    roleId: assertRoleId(node.roleId),
    disposition: enumValue(node.disposition, ["required", "optional"], `${label}.disposition`),
    capabilityId: assertRefId(node.capabilityId),
    capabilityContractDigest: assertPackDigest(node.capabilityContractDigest),
    allowedProviderPins,
    requiredReadinessDimensions: slugList(node.requiredReadinessDimensions, `${label}.requiredReadinessDimensions`, MAX_CLOSED_STRING_SET),
    requestedGrantKinds: slugList(node.requestedGrantKinds, `${label}.requestedGrantKinds`, MAX_CLOSED_STRING_SET),
    fallbackPolicy: parseFallbackPolicy(node.fallbackPolicy, `${label}.fallbackPolicy`),
    ...(node.requestedBounds === undefined
      ? {}
      : { requestedBounds: parseRequestedBounds(node.requestedBounds, `${label}.requestedBounds`) }),
  };
  return withDefaultPin(base, node, allowedProviderPins, label);
}

/**
 * The per-attempt ceilings a provider role requests, parsed closed.
 *
 * ALL FOUR ARE REQUIRED TOGETHER. A partial envelope would leave one dimension
 * unbounded while looking declared, and the unbounded one is exactly where an
 * unbounded run goes.
 */
function parseRequestedBounds(value: unknown, label: string): ProviderRequestedBoundsV2 {
  const node = record(value, label);
  exact(node, [
    "maxBrokerRequestsPerAttempt", "maxTokensPerAttempt",
    "maxCostMicrosPerAttempt", "maxWallTimeMsPerAttempt",
  ], []);
  return {
    maxBrokerRequestsPerAttempt: positiveCount(node.maxBrokerRequestsPerAttempt, `${label}.maxBrokerRequestsPerAttempt`),
    maxTokensPerAttempt: positiveCount(node.maxTokensPerAttempt, `${label}.maxTokensPerAttempt`),
    maxCostMicrosPerAttempt: positiveCount(node.maxCostMicrosPerAttempt, `${label}.maxCostMicrosPerAttempt`),
    maxWallTimeMsPerAttempt: positiveCount(node.maxWallTimeMsPerAttempt, `${label}.maxWallTimeMsPerAttempt`),
  };
}

/** Parse the workspace contract's eleven declared dimensions (section 12.1). */
/**
 * One optional-capability declaration, parsed closed (no unknown members).
 *
 * A BARE STRING IS STILL VALID. That was the field's original form, and an
 * installed package must keep parsing across a host upgrade — so the legacy
 * value is read as a dimension that names itself and declares no way to check
 * itself, never as a parse error.
 */
function readinessDimension(value: unknown, label: string): ProductReadinessDimensionV2 {
  if (typeof value === "string") return { dimensionId: assertSlug(value) };
  const node = record(value, label);
  exact(node, ["dimensionId"], ["credentialSlotId", "summaryKey", "degradedSummaryKey"]);
  return {
    dimensionId: assertSlug(node.dimensionId),
    ...(node.credentialSlotId === undefined ? {} : { credentialSlotId: assertSlug(node.credentialSlotId) }),
    ...(node.summaryKey === undefined ? {} : { summaryKey: assertRefId(node.summaryKey) }),
    ...(node.degradedSummaryKey === undefined ? {} : { degradedSummaryKey: assertRefId(node.degradedSummaryKey) }),
  };
}

/** The declared optional capabilities, with unique dimension ids. */
function readinessDimensions(value: unknown, label: string): ProductReadinessDimensionV2[] {
  const parsed = array(value, label, MAX_CLOSED_STRING_SET)
    .map((item, index) => readinessDimension(item, `${label}[${index}]`));
  assertUniqueStrings(parsed.map((dimension) => dimension.dimensionId), label);
  return parsed;
}

export function parseWorkspaceContract(value: unknown, label: string): WorkspaceContractV2 {
  const node = record(value, label);
  exact(node, WORKSPACE_KEYS);
  return {
    workspaceIdentityGrammar: assertRefId(node.workspaceIdentityGrammar),
    requiredKnowledgeProfileId: assertRefId(node.requiredKnowledgeProfileId),
    compatibleKnowledgeProfileDigests: digestList(node.compatibleKnowledgeProfileDigests, `${label}.compatibleKnowledgeProfileDigests`, MAX_CLOSED_STRING_SET),
    catalogSchemaDependencies: refList(node.catalogSchemaDependencies, `${label}.catalogSchemaDependencies`, MAX_CLOSED_STRING_SET),
    sourceSchemaDependencies: refList(node.sourceSchemaDependencies, `${label}.sourceSchemaDependencies`, MAX_CLOSED_STRING_SET),
    allowedContextRootPolicyIds: slugList(node.allowedContextRootPolicyIds, `${label}.allowedContextRootPolicyIds`, MAX_CLOSED_STRING_SET),
    declaredProjectionClasses: slugList(node.declaredProjectionClasses, `${label}.declaredProjectionClasses`, MAX_CLOSED_STRING_SET),
    requiredSettingFields: slugList(node.requiredSettingFields, `${label}.requiredSettingFields`, MAX_CLOSED_STRING_SET),
    requiredProviderCapabilityRoles: slugList(node.requiredProviderCapabilityRoles, `${label}.requiredProviderCapabilityRoles`, MAX_CLOSED_STRING_SET),
    supportedImportCompatibilityModes: slugList(node.supportedImportCompatibilityModes, `${label}.supportedImportCompatibilityModes`, MAX_CLOSED_STRING_SET),
    productReadinessDimensions: readinessDimensions(node.productReadinessDimensions, `${label}.productReadinessDimensions`),
  };
}
