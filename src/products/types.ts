/**
 * @file src/products/types.ts
 * @description Closed, data-only value objects for the WOP V3 product package
 * contract (design sections 7.1, 7.2, 7.4). These records describe authority but
 * expose no callbacks, executable adapters, or writable paths; every digest
 * reuses the repository's branded {@link Sha256Digest} so a mistyped hash cannot
 * flow past the parser. Members are immutable data references, never code.
 */

import type { Sha256Digest } from "../capability-providers/types.js";

export type { Sha256Digest } from "../capability-providers/types.js";

/** The closed kinds a package member reference may declare. */
export type PackageMemberKind =
  | "knowledge-profile"
  | "operations-pack"
  | "composition-lock"
  | "interaction-resource"
  | "parity-ledger"
  | "parity-fixture"
  | "process-definition"
  | "documentation";

/** An immutable, content-addressed reference to one package member (section 7.2). */
export interface PackageMemberRefV1 {
  memberId: string;
  kind: PackageMemberKind;
  digest: Sha256Digest;
  byteCount: number;
  mediaType: string;
}

/** A pinned provider capability the runtime authority binds (section 7.1). */
/**
 * The EXACT Provider V2 pin — the platform's own type, not a product-local copy.
 *
 * WOP V3 requires the complete identity and forbids a partial one, and a second
 * declaration of "the pin" is how a partial one gets in: the product parser
 * previously demanded a SEMVER capability contract version, which real pins do
 * not carry, so a genuine repository pin could not pass through a package at
 * all. Re-exporting the platform type keeps one definition and one parser.
 */
import type { ProviderPinV1 } from "../capability-providers/types.js";
export type { ProviderPinV1 };

/** One active experience descriptor bound to an interaction resource by digest. */
export interface ExperienceSurfaceV1 {
  surfaceId: string;
  interactionResourceDigest: Sha256Digest;
}

/** One supported OS, architecture, and runtime row (section 7.4). */
export interface CompatibilityRuntimeV1 {
  os: string;
  arch: string;
  runtime: string;
}

/** One supported agent host and its adapter-version floor (section 7.4). */
export interface CompatibilityHostV1 {
  hostId: string;
  minAdapterVersion: string;
}

/**
 * One explicitly unsupported combination and its stable reason code (section
 * 7.4). At least one dimension field names the combination; a bare reason code
 * with no dimension is not a combination and fails closed at the parser.
 */
export interface CompatibilityUnsupportedV1 {
  os?: string;
  arch?: string;
  runtime?: string;
  hostId?: string;
  sandboxBackend?: string;
  reasonCode: string;
}

/** Compatible knowledge and workspace import modes (section 7.4). */
export interface CompatibilityImportModesV1 {
  knowledge: string[];
  workspace: string[];
}

/** The closed compatibility contract populated from pinned evidence (section 7.4). */
export interface ProductCompatibilityV1 {
  minLlmwikiVersion: string;
  maxLlmwikiVersion?: string;
  supportedRuntimes: CompatibilityRuntimeV1[];
  requiredSandboxBackends: string[];
  supportedHosts: CompatibilityHostV1[];
  requiredFeatureIds: string[];
  compatibleImportModes: CompatibilityImportModesV1;
  unsupportedCombinations: CompatibilityUnsupportedV1[];
}

/** The immutable version-one product package manifest (section 7.1). */
export interface ProductPackageManifestV1 {
  schemaVersion: 1;
  productId: string;
  productVersion: string;
  displayName: string;
  publisher: string;
  packageDigest: Sha256Digest;
  runtimeAuthorityDigest: Sha256Digest;
  minLlmwikiVersion: string;
  productSpecDigest: Sha256Digest;
  members: PackageMemberRefV1[];
  knowledgeProfile: PackageMemberRefV1;
  rootOperationsPack: PackageMemberRefV1;
  compositionLock: PackageMemberRefV1;
  /** Optional canonical process descriptor for product-driven workflows. */
  processDefinition?: PackageMemberRefV1;
  providerPins: ProviderPinV1[];
  interactionResources: PackageMemberRefV1[];
  parityLedger: PackageMemberRefV1;
  compatibility: ProductCompatibilityV1;
  supportedSurfaces: ExperienceSurfaceV1[];
  supportedLocales: string[];
  createdAt: string;
}

/**
 * The exact canonical preimage of {@link ProductPackageManifestV1.runtimeAuthorityDigest}
 * (section 7.1). `productVersion` is DELIBERATELY EXCLUDED so an evidence-only or
 * version-label reissue with byte-identical runtime authority stays provably
 * identical; the parity ledger, fixtures, certificate, and non-runtime docs are
 * excluded for the same reason.
 */
export interface ProductRuntimeAuthorityV1 {
  schemaVersion: 1;
  productId: string;
  knowledgeProfileDigest: Sha256Digest;
  rootOperationsPackDigest: Sha256Digest;
  compositionLockDigest: Sha256Digest;
  /** Present only when the package declares product process authority. */
  processDefinitionDigest?: Sha256Digest;
  providerPins: ProviderPinV1[];
  interactionResourceDigests: Sha256Digest[];
  compatibilityDigest: Sha256Digest;
  supportedSurfaces: ExperienceSurfaceV1[];
  supportedLocales: string[];
}

/** How a package's provenance was established. Slice 1 writes only local. */
export type ProductInstallProvenance = "builtin" | "remote-verified" | "local-unverified";

/**
 * The advisory install receipt (section 7.6). It records provenance and package
 * identity but confers NO activation authority; a missing or unreadable receipt
 * leaves inert bytes with provenance unavailable rather than an active binding.
 */
export interface ProductInstallReceiptV1 {
  schemaVersion: 1;
  productId: string;
  productVersion: string;
  packageDigest: Sha256Digest;
  runtimeAuthorityDigest: Sha256Digest;
  provenance: ProductInstallProvenance;
  installedAt: string;
}
