/**
 * @file src/products/packages/verify.ts
 * @description Recomputes and re-verifies a product package's digests and member
 * table (design section 7.1). The loader RECOMPUTES packageDigest over the
 * canonical manifest with packageDigest omitted and runtimeAuthorityDigest over
 * the exact runtime-authority preimage — which deliberately EXCLUDES
 * productVersion — and fails closed on any mismatch. It proves the member table
 * is complete: every named profile, pack, lock, and interaction reference
 * resolves to exactly one un-substituted entry, every interaction resource is
 * driven by a surface, and every non-documentation member is referenced. It
 * enforces the section 7.5 byte ceilings and rejects any forbidden media type.
 * Fixture reference resolution runs through the parity ledger, deferred to a
 * later slice, so a fixture member is unreferenced here and fails closed.
 */

import { createHash } from "node:crypto";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  MAX_ALL_DECLARATIVE_MEMBER_BYTES, MAX_ALL_INTERACTION_RESOURCES_BYTES,
  MAX_COMPOSITION_LOCK_BYTES, MAX_DOCUMENTATION_MEMBER_BYTES, MAX_IMPORTED_OPERATIONS_PACK_BYTES,
  MAX_INTERACTION_RESOURCE_BYTES, MAX_KNOWLEDGE_PROFILE_BYTES, MAX_OPERATIONS_PACK_GRAPH_BYTES,
  MAX_PARITY_FIXTURE_BYTES, MAX_PARITY_LEDGER_BYTES, MAX_PROCESS_DEFINITION_BYTES,
  MAX_ROOT_OPERATIONS_PACK_BYTES,
  PRODUCT_RUNTIME_AUTHORITY_SCHEMA_VERSION,
} from "../constants.js";
import { assertMemberMediaType, digestDirectoryName, type Sha256Digest } from "../ids.js";
import { ProductBoundsError, ProductPackageError } from "../problems.js";
import { parseProductPackageManifest } from "./protocol.js";
import type {
  PackageMemberKind, PackageMemberRefV1, ProductPackageManifestV1, ProductRuntimeAuthorityV1,
} from "../types.js";

/** The per-kind byte ceiling one member's declared size may not exceed. */
const MEMBER_BYTE_CAP: Readonly<Record<PackageMemberKind, number>> = {
  "knowledge-profile": MAX_KNOWLEDGE_PROFILE_BYTES,
  "operations-pack": MAX_IMPORTED_OPERATIONS_PACK_BYTES,
  "composition-lock": MAX_COMPOSITION_LOCK_BYTES,
  "interaction-resource": MAX_INTERACTION_RESOURCE_BYTES,
  "parity-ledger": MAX_PARITY_LEDGER_BYTES,
  "parity-fixture": MAX_PARITY_FIXTURE_BYTES,
  "process-definition": MAX_PROCESS_DEFINITION_BYTES,
  documentation: MAX_DOCUMENTATION_MEMBER_BYTES,
};

/** Recompute packageDigest over the canonical manifest with packageDigest omitted. */
export function recomputePackageDigest(manifest: ProductPackageManifestV1): Sha256Digest {
  const { packageDigest: _omitted, ...rest } = manifest;
  return canonicalDigest(rest) as Sha256Digest;
}

/** Build the exact runtime-authority preimage; productVersion is excluded. */
function computeRuntimeAuthority(manifest: ProductPackageManifestV1): ProductRuntimeAuthorityV1 {
  const authority: ProductRuntimeAuthorityV1 = {
    schemaVersion: PRODUCT_RUNTIME_AUTHORITY_SCHEMA_VERSION,
    productId: manifest.productId,
    knowledgeProfileDigest: manifest.knowledgeProfile.digest,
    rootOperationsPackDigest: manifest.rootOperationsPack.digest,
    compositionLockDigest: manifest.compositionLock.digest,
    providerPins: manifest.providerPins,
    interactionResourceDigests: manifest.interactionResources.map((resource) => resource.digest),
    compatibilityDigest: canonicalDigest(manifest.compatibility) as Sha256Digest,
    supportedSurfaces: manifest.supportedSurfaces,
    supportedLocales: manifest.supportedLocales,
  };
  return manifest.processDefinition === undefined
    ? authority
    : { ...authority, processDefinitionDigest: manifest.processDefinition.digest };
}

/** Recompute runtimeAuthorityDigest over the exact runtime-authority preimage. */
export function recomputeRuntimeAuthorityDigest(manifest: ProductPackageManifestV1): Sha256Digest {
  return canonicalDigest(computeRuntimeAuthority(manifest)) as Sha256Digest;
}

/** Whether two references name byte-identical immutable member data. */
function sameMemberRef(a: PackageMemberRefV1, b: PackageMemberRefV1): boolean {
  return a.kind === b.kind && a.digest === b.digest && a.byteCount === b.byteCount
    && a.mediaType === b.mediaType;
}

/** Index members by id, failing closed on a duplicate id or duplicate digest. */
function buildMemberIndex(members: readonly PackageMemberRefV1[]): Map<string, PackageMemberRefV1> {
  const byId = new Map<string, PackageMemberRefV1>();
  const digests = new Set<Sha256Digest>();
  for (const member of members) {
    byId.set(member.memberId, member);
    digests.add(member.digest);
  }
  if (byId.size !== members.length) throw new ProductPackageError("member table has duplicate member ids");
  if (digests.size !== members.length) throw new ProductPackageError("member table has duplicate member digests");
  return byId;
}

/** Resolve one named reference to its un-substituted member-table entry. */
function resolveNamed(
  byId: ReadonlyMap<string, PackageMemberRefV1>, ref: PackageMemberRefV1,
  expectedKind: PackageMemberKind, referenced: Set<string>,
): void {
  if (ref.kind !== expectedKind) throw new ProductPackageError(`${expectedKind} slot declares the wrong member kind`);
  assertMemberMediaType(ref.kind, ref.mediaType);
  const member = byId.get(ref.memberId);
  if (member === undefined) throw new ProductPackageError(`${expectedKind} slot member is absent from the table`);
  if (!sameMemberRef(member, ref)) throw new ProductPackageError(`${expectedKind} slot member was substituted`);
  referenced.add(ref.memberId);
}

/** Require every surface to drive a declared resource and every resource a surface. */
function assertSurfaceCoverage(manifest: ProductPackageManifestV1): void {
  const declared = new Set(manifest.interactionResources.map((resource) => resource.digest));
  const covered = new Set<Sha256Digest>();
  for (const surface of manifest.supportedSurfaces) {
    if (!declared.has(surface.interactionResourceDigest)) {
      throw new ProductPackageError("a surface references an undeclared interaction resource");
    }
    covered.add(surface.interactionResourceDigest);
  }
  for (const resource of manifest.interactionResources) {
    if (!covered.has(resource.digest)) throw new ProductPackageError("an interaction resource drives no surface");
  }
}

/** Prove the member table is complete and free of unreferenced runtime bytes. */
function assertCompleteMemberTable(manifest: ProductPackageManifestV1): void {
  const byId = buildMemberIndex(manifest.members);
  const referenced = new Set<string>();
  resolveNamed(byId, manifest.knowledgeProfile, "knowledge-profile", referenced);
  resolveNamed(byId, manifest.rootOperationsPack, "operations-pack", referenced);
  resolveNamed(byId, manifest.compositionLock, "composition-lock", referenced);
  if (manifest.processDefinition !== undefined) {
    resolveNamed(byId, manifest.processDefinition, "process-definition", referenced);
  }
  resolveNamed(byId, manifest.parityLedger, "parity-ledger", referenced);
  for (const resource of manifest.interactionResources) {
    resolveNamed(byId, resource, "interaction-resource", referenced);
  }
  assertSurfaceCoverage(manifest);
  for (const member of manifest.members) {
    if (!referenced.has(member.memberId) && member.kind !== "documentation") {
      throw new ProductPackageError("the member table carries an unreferenced non-documentation member");
    }
  }
}

/** Fail closed on any two provider pins sharing one logical capability identity. */
function assertProviderPinsDistinct(manifest: ProductPackageManifestV1): void {
  const logical = new Set<string>();
  for (const pin of manifest.providerPins) {
    const key = `${pin.coordinate} ${pin.capabilityId} ${pin.capabilityContractVersion}`;
    if (logical.has(key)) throw new ProductPackageError("provider pins contain a duplicate logical identity");
    logical.add(key);
  }
}

/** Enforce every per-member and aggregate section 7.5 byte ceiling. */
function assertMemberBounds(manifest: ProductPackageManifestV1): void {
  if (manifest.rootOperationsPack.byteCount > MAX_ROOT_OPERATIONS_PACK_BYTES) {
    throw new ProductBoundsError("root operations pack");
  }
  let graphBytes = 0, interactionBytes = 0, declarativeBytes = 0;
  for (const member of manifest.members) {
    if (member.byteCount > MEMBER_BYTE_CAP[member.kind]) throw new ProductBoundsError(`${member.kind} member`);
    declarativeBytes += member.byteCount;
    if (member.kind === "operations-pack") graphBytes += member.byteCount;
    if (member.kind === "interaction-resource") interactionBytes += member.byteCount;
  }
  if (graphBytes > MAX_OPERATIONS_PACK_GRAPH_BYTES) throw new ProductBoundsError("operations-pack graph");
  if (interactionBytes > MAX_ALL_INTERACTION_RESOURCES_BYTES) throw new ProductBoundsError("all interaction resources");
  if (declarativeBytes > MAX_ALL_DECLARATIVE_MEMBER_BYTES) throw new ProductBoundsError("all declarative members");
}

/**
 * Recompute both digests and re-prove the member table and bounds. Any digest
 * mismatch, incomplete table, substitution, or exceeded ceiling fails closed.
 */
function verifyProductPackageManifest(manifest: ProductPackageManifestV1): void {
  assertProviderPinsDistinct(manifest);
  assertCompleteMemberTable(manifest);
  assertMemberBounds(manifest);
  if (recomputeRuntimeAuthorityDigest(manifest) !== manifest.runtimeAuthorityDigest) {
    throw new ProductPackageError("recomputed runtimeAuthorityDigest does not match the manifest");
  }
  if (recomputePackageDigest(manifest) !== manifest.packageDigest) {
    throw new ProductPackageError("recomputed packageDigest does not match the manifest");
  }
}

/** Parse then fully verify one canonical manifest document, returning the record. */
export function loadProductPackageManifest(text: string): ProductPackageManifestV1 {
  const manifest = parseProductPackageManifest(text);
  verifyProductPackageManifest(manifest);
  return manifest;
}

/** Verify buffered member bytes hash and size to every entry in the member table. */
export function verifyProductPackageMemberBytes(
  manifest: ProductPackageManifestV1, bytesByHex: ReadonlyMap<string, Buffer>,
): void {
  for (const member of manifest.members) {
    const hex = digestDirectoryName(member.digest);
    const bytes = bytesByHex.get(hex);
    if (bytes === undefined) throw new ProductPackageError("a member's bytes are missing");
    if (bytes.byteLength !== member.byteCount) throw new ProductPackageError("a member's byte count disagrees");
    if (createHash("sha256").update(bytes).digest("hex") !== hex) {
      throw new ProductPackageError("a member's bytes disagree with its digest");
    }
  }
}
