/**
 * @file test/products/binding-fixture.ts
 * @description Builds the product packages the active-binding tests share, on top
 * of {@link ./product-package-fixture} so no manifest-assembly logic is duplicated.
 * `buildActivatableProduct` supplies a valid knowledge-profile member, a composable
 * operations-pack member, and its exactly-matching composition lock;
 * `buildProfileOnlyProduct` supplies a valid knowledge profile with an inert
 * (non-composable) pack — enough for product-mode resolution. It also commits a
 * built package into the immutable store and assembles a valid
 * ActiveProductBindingV1 whose component digests match the manifest, so a negative
 * test can perturb exactly one property while every other stays well-formed.
 */

import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { commitProductPackage } from "../../src/products/packages/store.js";
import { deriveBindingComponents } from "../../src/products/binding/manifest-authority.js";
import { ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION } from "../../src/products/binding/types.js";
import type { ActiveProductBindingV1, PrincipalRefV1 } from "../../src/products/binding/types.js";
import type { Sha256Digest } from "../../src/products/ids.js";
import type { ProductPackageManifestV1 } from "../../src/products/types.js";
import { recomputeCompositionLock } from "../../src/operations-packs/composition-lock.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import { buildPack, dg } from "../operations-packs/pack-fixture.js";
import { buildProductPackage, type BuiltProductPackage } from "./product-package-fixture.js";

const ACTIVATED_AT = "2026-01-01T00:00:00.000Z";

/** The audit principal every fixture binding records. */
export const FIXTURE_PRINCIPAL: PrincipalRefV1 = { id: "operator-1", surface: "cli" };

/** A valid, non-default knowledge profile; `displayName` varies to distinguish packages. */
function validProfile(displayName: string): Record<string, unknown> {
  return {
    schemaVersion: 1, profileId: "custom", displayName,
    entities: { docs: { directory: "wiki/docs" } },
    workflows: { build: { stages: [{ id: "observe", reads: ["docs"], writes: [] }] } },
  };
}

/** Build a fully activatable product; `variant` distinguishes two packages by digest. */
export function buildActivatableProduct(
  variant = "Demo Product", processDefinitionBody?: string,
  knowledgeProfile: Record<string, unknown> = validProfile(variant),
): BuiltProductPackage {
  const pack = buildPack();
  return buildProductPackage({
    knowledgeProfileBody: canonicalBytes(knowledgeProfile).toString("utf8"),
    operationsPackBody: canonicalBytes(pack).toString("utf8"),
    compositionLockBody: canonicalBytes(recomputeCompositionLock(pack)).toString("utf8"),
    processDefinitionBody,
  });
}

/** Build a product with a valid knowledge profile but a non-composable pack member. */
export function buildProfileOnlyProduct(): BuiltProductPackage {
  return buildProductPackage({ knowledgeProfileBody: canonicalBytes(validProfile("Demo Product")).toString("utf8") });
}

/**
 * Build an activatable product whose pack requires a provider contract digest the
 * host does NOT declare — composable and schema-supported in every other respect,
 * so activation refuses ONLY on the unrecognized contract pin (P1-B).
 */
export function buildContractMismatchedProduct(): BuiltProductPackage {
  const pack = buildPack();
  const mismatched: WorkspaceOperationsPackV2 = {
    ...pack,
    requires: { ...pack.requires, providerContractDigest: dg("unrecognized-provider-contract") },
  };
  return buildProductPackage({
    knowledgeProfileBody: canonicalBytes(validProfile("Demo Product")).toString("utf8"),
    operationsPackBody: canonicalBytes(mismatched).toString("utf8"),
    compositionLockBody: canonicalBytes(recomputeCompositionLock(mismatched)).toString("utf8"),
  });
}

/** Commit a built package into the immutable store under `root`. */
export async function commitBuilt(root: string, product: BuiltProductPackage): Promise<Sha256Digest> {
  await commitProductPackage(root, product.manifest, product.bytesByHex);
  return product.manifest.packageDigest;
}

/** Assemble a valid binding for a manifest, optionally overriding one field. */
export function bindingFor(
  manifest: ProductPackageManifestV1, overrides: Partial<ActiveProductBindingV1> = {},
): ActiveProductBindingV1 {
  return {
    schemaVersion: ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION,
    ...deriveBindingComponents(manifest),
    activatedAt: ACTIVATED_AT,
    activatedBy: FIXTURE_PRINCIPAL,
    ...overrides,
  };
}

/** Render one binding as the canonical UTF-8 text the store persists. */
export function serializeBinding(binding: ActiveProductBindingV1): string {
  return canonicalBytes(binding).toString("utf8");
}
