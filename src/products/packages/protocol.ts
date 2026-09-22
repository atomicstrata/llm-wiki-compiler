/**
 * @file src/products/packages/protocol.ts
 * @description Bounded, duplicate-key-free structural loader for the immutable
 * version-one product package manifest (design sections 7.1, 7.2). It rebuilds an
 * allowlisted record through the shared canonical-JSON unique-key parser, rejects
 * unknown and missing fields, holds every caller-influenced identity to its
 * closed grammar, rejects any member media type outside the per-kind data
 * allowlist, and requires every declared collection to arrive in strictly
 * ascending canonical order so its byte representation and digest are
 * deterministic. Digest recomputation, member-table completeness, and bounds are
 * the verifier's job; this layer proves shape only.
 */

import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { parseAuthorityProviderPin } from "../../capability-providers/authority/grants-parse.js";
import {
  array, count, enumValue, exact, record, textValue, timestamp,
} from "../../operation-bundles/manifest-values.js";
import type { JsonRecord } from "../../operation-bundles/manifest-values.js";
import {
  MAX_COMPATIBILITY_FEATURES, MAX_COMPATIBILITY_HOSTS, MAX_COMPATIBILITY_IMPORT_MODES,
  MAX_COMPATIBILITY_RUNTIMES, MAX_COMPATIBILITY_SANDBOX_BACKENDS, MAX_COMPATIBILITY_UNSUPPORTED,
  MAX_DISPLAY_TEXT_BYTES, MAX_INTERACTION_RESOURCE_MEMBERS, MAX_PACKAGE_MEMBERS, MAX_PROVIDER_PINS,
  MAX_PRODUCT_MANIFEST_BYTES, MAX_SUPPORTED_LOCALES, MAX_SUPPORTED_SURFACES, PRODUCT_PACKAGE_SCHEMA_VERSION,
} from "../constants.js";
import {
  assertHostId, assertLocale, assertMemberId, assertMemberMediaType,
  assertProductDigest, assertProductId, assertReasonCode, assertSurfaceId, assertVersion,
} from "../ids.js";
import { asProductProblem, ProductPackageError } from "../problems.js";
import type {
  CompatibilityHostV1, CompatibilityImportModesV1, CompatibilityRuntimeV1,
  CompatibilityUnsupportedV1, ExperienceSurfaceV1, PackageMemberKind, PackageMemberRefV1,
  ProductCompatibilityV1, ProductPackageManifestV1, ProviderPinV1,
} from "../types.js";

const PACKAGE_MEMBER_KINDS: readonly PackageMemberKind[] = [
  "knowledge-profile", "operations-pack", "composition-lock", "interaction-resource",
  "parity-ledger", "parity-fixture", "process-definition", "documentation",
];

const TOP_KEYS = [
  "schemaVersion", "productId", "productVersion", "displayName", "publisher",
  "packageDigest", "runtimeAuthorityDigest", "minLlmwikiVersion", "productSpecDigest",
  "members", "knowledgeProfile", "rootOperationsPack", "compositionLock", "providerPins",
  "interactionResources", "parityLedger", "compatibility", "supportedSurfaces",
  "supportedLocales", "createdAt",
] as const;
const TOP_OPTIONAL = ["processDefinition"] as const;

const MEMBER_KEYS = ["memberId", "kind", "digest", "byteCount", "mediaType"] as const;
const PIN_KEYS = [
  "schemaVersion", "coordinate", "providerId", "providerVersion", "packageDigest",
  "manifestDigest", "capabilityId", "capabilityContractVersion", "capabilitySchemaDigest",
] as const;
const SURFACE_KEYS = ["surfaceId", "interactionResourceDigest"] as const;
const RUNTIME_KEYS = ["os", "arch", "runtime"] as const;
const HOST_KEYS = ["hostId", "minAdapterVersion"] as const;
const COMPAT_KEYS = [
  "minLlmwikiVersion", "supportedRuntimes", "requiredSandboxBackends", "supportedHosts",
  "requiredFeatureIds", "compatibleImportModes", "unsupportedCombinations",
] as const;
const COMPAT_OPTIONAL = ["maxLlmwikiVersion"] as const;

/** Require a nonnegative safe integer of at least one byte for a member size. */
function memberByteCount(value: unknown, label: string): number {
  const parsed = count(value, label);
  if (parsed < 1) throw new ProductPackageError(`${label} must be at least one byte`);
  return parsed;
}

/** Rebuild one immutable member reference, holding its media type to the kind. */
function parseMemberRef(value: unknown, label: string): PackageMemberRefV1 {
  const node = record(value, label);
  exact(node, MEMBER_KEYS);
  const kind = enumValue(node.kind, PACKAGE_MEMBER_KINDS, `${label} kind`);
  return {
    memberId: assertMemberId(node.memberId),
    kind,
    digest: assertProductDigest(node.digest),
    byteCount: memberByteCount(node.byteCount, `${label} byteCount`),
    mediaType: assertMemberMediaType(kind, node.mediaType),
  };
}

/** Rebuild one provider pin from its four exact coordinate and digest fields. */
function parseProviderPin(value: unknown, label: string): ProviderPinV1 {
  // THE PLATFORM'S OWN PARSER, not a product-local restatement. It checks the
  // coordinate against the provider id and version it embeds, and treats the
  // capability contract version as the OPAQUE identifier it is — the local copy
  // demanded semver and rejected every real pin.
  try {
    return parseAuthorityProviderPin(value);
  } catch {
    throw new ProductPackageError(`${label} is not a complete provider pin`);
  }
}

/** Rebuild one experience surface bound to its interaction resource by digest. */
function parseSurface(value: unknown, label: string): ExperienceSurfaceV1 {
  const node = record(value, label);
  exact(node, SURFACE_KEYS);
  return {
    surfaceId: assertSurfaceId(node.surfaceId),
    interactionResourceDigest: assertProductDigest(node.interactionResourceDigest),
  };
}

/** Rebuild one supported runtime row from its os, arch, and runtime fields. */
function parseRuntime(value: unknown, label: string): CompatibilityRuntimeV1 {
  const node = record(value, label);
  exact(node, RUNTIME_KEYS);
  return {
    os: assertReasonCode(node.os),
    arch: assertReasonCode(node.arch),
    runtime: assertReasonCode(node.runtime),
  };
}

/** Rebuild one supported agent-host row and its adapter-version floor. */
function parseHost(value: unknown, label: string): CompatibilityHostV1 {
  const node = record(value, label);
  exact(node, HOST_KEYS);
  return { hostId: assertHostId(node.hostId), minAdapterVersion: assertVersion(node.minAdapterVersion) };
}

/** One nameable dimension of an unsupported combination and its grammar. */
type UnsupportedDimension = keyof Omit<CompatibilityUnsupportedV1, "reasonCode">;
const UNSUPPORTED_DIMENSIONS: readonly [UnsupportedDimension, (value: unknown) => string][] = [
  ["os", assertReasonCode], ["arch", assertReasonCode], ["runtime", assertReasonCode],
  ["hostId", assertHostId], ["sandboxBackend", assertReasonCode],
];
const UNSUPPORTED_OPTIONAL = UNSUPPORTED_DIMENSIONS.map(([key]) => key);

/** Rebuild one unsupported combination: at least one dimension plus a reason code. */
function parseUnsupported(value: unknown, label: string): CompatibilityUnsupportedV1 {
  const node = record(value, label);
  exact(node, ["reasonCode"], UNSUPPORTED_OPTIONAL);
  const dimensions: Partial<Record<UnsupportedDimension, string>> = {};
  for (const [key, assertValue] of UNSUPPORTED_DIMENSIONS) {
    if (node[key] !== undefined) dimensions[key] = assertValue(node[key]);
  }
  if (Object.keys(dimensions).length === 0) {
    throw new ProductPackageError(`${label} must name at least one unsupported dimension`);
  }
  return { ...dimensions, reasonCode: assertReasonCode(node.reasonCode) };
}

/** Rebuild one ascending, unique reason-code list under its cap. */
function reasonCodeList(value: unknown, cap: number, label: string): string[] {
  return ascending(array(value, label, cap).map((code) => assertReasonCode(code)), (code) => code, label);
}

/** Rebuild the compatible knowledge and workspace import-mode lists. */
function parseImportModes(value: unknown): CompatibilityImportModesV1 {
  const node = record(value, "compatibleImportModes");
  exact(node, ["knowledge", "workspace"]);
  return {
    knowledge: reasonCodeList(node.knowledge, MAX_COMPATIBILITY_IMPORT_MODES, "compatibleImportModes.knowledge"),
    workspace: reasonCodeList(node.workspace, MAX_COMPATIBILITY_IMPORT_MODES, "compatibleImportModes.workspace"),
  };
}

/** The runtime sort key: os, arch, then runtime, NUL-separated (section 7.4). */
function runtimeKey(row: CompatibilityRuntimeV1): string {
  return `${row.os}\0${row.arch}\0${row.runtime}`;
}

/** The unsupported-combination sort key over its dimensions and reason code. */
function unsupportedKey(row: CompatibilityUnsupportedV1): string {
  return [row.os, row.arch, row.runtime, row.hostId, row.sandboxBackend, row.reasonCode]
    .map((field) => field ?? "").join("\0");
}

/** Rebuild the closed compatibility contract from its finite closed rows (section 7.4). */
function parseCompatibility(value: unknown): ProductCompatibilityV1 {
  const node = record(value, "compatibility");
  exact(node, COMPAT_KEYS, COMPAT_OPTIONAL);
  const contract: ProductCompatibilityV1 = {
    minLlmwikiVersion: assertVersion(node.minLlmwikiVersion),
    supportedRuntimes: ascending(array(node.supportedRuntimes, "supportedRuntimes", MAX_COMPATIBILITY_RUNTIMES)
      .map((item, index) => parseRuntime(item, `supportedRuntimes[${index}]`)), runtimeKey, "supportedRuntimes"),
    requiredSandboxBackends: reasonCodeList(node.requiredSandboxBackends, MAX_COMPATIBILITY_SANDBOX_BACKENDS, "requiredSandboxBackends"),
    supportedHosts: ascending(array(node.supportedHosts, "supportedHosts", MAX_COMPATIBILITY_HOSTS)
      .map((item, index) => parseHost(item, `supportedHosts[${index}]`)), (row) => row.hostId, "supportedHosts"),
    requiredFeatureIds: reasonCodeList(node.requiredFeatureIds, MAX_COMPATIBILITY_FEATURES, "requiredFeatureIds"),
    compatibleImportModes: parseImportModes(node.compatibleImportModes),
    unsupportedCombinations: ascending(array(node.unsupportedCombinations, "unsupportedCombinations",
      MAX_COMPATIBILITY_UNSUPPORTED).map((item, index) => parseUnsupported(item, `unsupportedCombinations[${index}]`)),
      unsupportedKey, "unsupportedCombinations"),
  };
  return node.maxLlmwikiVersion === undefined
    ? contract : { ...contract, maxLlmwikiVersion: assertVersion(node.maxLlmwikiVersion) };
}

/** Require a parsed collection to arrive in strictly ascending canonical order. */
function ascending<T>(items: T[], keyFn: (item: T) => string, label: string): T[] {
  for (let index = 1; index < items.length; index += 1) {
    if (keyFn(items[index - 1]!) >= keyFn(items[index]!)) {
      throw new ProductPackageError(`${label} must be sorted and free of duplicates`);
    }
  }
  return items;
}

/** The composite sort key provider pins order by: coordinate then digest (section 7.1). */
function providerPinKey(pin: ProviderPinV1): string {
  return `${pin.coordinate}\0${pin.capabilityId}\0${pin.capabilityContractVersion}\0${pin.packageDigest}`;
}

/** Rebuild the declared member, pin, resource, surface, and locale collections. */
function parseCollections(root: JsonRecord): Pick<ProductPackageManifestV1,
  "members" | "providerPins" | "interactionResources" | "supportedSurfaces" | "supportedLocales"> {
  return {
    members: ascending(array(root.members, "members", MAX_PACKAGE_MEMBERS)
      .map((item, index) => parseMemberRef(item, `members[${index}]`)), (member) => member.memberId, "members"),
    providerPins: ascending(array(root.providerPins, "providerPins", MAX_PROVIDER_PINS)
      .map((item, index) => parseProviderPin(item, `providerPins[${index}]`)), providerPinKey, "providerPins"),
    interactionResources: ascending(array(root.interactionResources, "interactionResources",
      MAX_INTERACTION_RESOURCE_MEMBERS).map((item, index) => parseMemberRef(item, `interactionResources[${index}]`)),
      (member) => member.digest, "interactionResources"),
    supportedSurfaces: ascending(array(root.supportedSurfaces, "supportedSurfaces", MAX_SUPPORTED_SURFACES)
      .map((item, index) => parseSurface(item, `supportedSurfaces[${index}]`)), (row) => row.surfaceId, "supportedSurfaces"),
    supportedLocales: ascending(array(root.supportedLocales, "supportedLocales", MAX_SUPPORTED_LOCALES)
      .map((item) => assertLocale(item)), (tag) => tag, "supportedLocales"),
  };
}

/** Rebuild the manifest's scalar identity and named single-member reference fields. */
function parseScalars(root: JsonRecord): Omit<ProductPackageManifestV1,
  "members" | "providerPins" | "interactionResources" | "supportedSurfaces" | "supportedLocales"> {
  const scalars: Omit<ProductPackageManifestV1,
    "members" | "providerPins" | "interactionResources" | "supportedSurfaces" | "supportedLocales" | "processDefinition"> = {
    schemaVersion: PRODUCT_PACKAGE_SCHEMA_VERSION,
    productId: assertProductId(root.productId),
    productVersion: assertVersion(root.productVersion),
    displayName: textValue(root.displayName, "displayName", MAX_DISPLAY_TEXT_BYTES),
    publisher: textValue(root.publisher, "publisher", MAX_DISPLAY_TEXT_BYTES),
    packageDigest: assertProductDigest(root.packageDigest),
    runtimeAuthorityDigest: assertProductDigest(root.runtimeAuthorityDigest),
    minLlmwikiVersion: assertVersion(root.minLlmwikiVersion),
    productSpecDigest: assertProductDigest(root.productSpecDigest),
    knowledgeProfile: parseMemberRef(root.knowledgeProfile, "knowledgeProfile"),
    rootOperationsPack: parseMemberRef(root.rootOperationsPack, "rootOperationsPack"),
    compositionLock: parseMemberRef(root.compositionLock, "compositionLock"),
    parityLedger: parseMemberRef(root.parityLedger, "parityLedger"),
    compatibility: parseCompatibility(root.compatibility),
    createdAt: timestamp(root.createdAt),
  };
  return root.processDefinition === undefined
    ? scalars
    : { ...scalars, processDefinition: parseMemberRef(root.processDefinition, "processDefinition") };
}

/** Rebuild and structurally validate one complete version-one product manifest. */
export function parseProductPackageManifest(text: string): ProductPackageManifestV1 {
  return asProductProblem(() => {
    const root = record(parseBoundedUniqueJson(text, MAX_PRODUCT_MANIFEST_BYTES), "product manifest");
    exact(root, TOP_KEYS, TOP_OPTIONAL);
    if (root.schemaVersion !== PRODUCT_PACKAGE_SCHEMA_VERSION) {
      throw new ProductPackageError("product manifest schemaVersion must be 1");
    }
    return { ...parseScalars(root), ...parseCollections(root) };
  });
}
