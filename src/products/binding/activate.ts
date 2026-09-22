/**
 * @file src/products/binding/activate.ts
 * @description Activate an installed product under the project lock (design
 * section 8.3). Activation runs the shared recovery gate, then, all under the
 * lock: (1) resolves the exact installed package offline; (2) verifies its
 * members, the complete composition graph, the supported schema versions, and the
 * pack's declared contract requirements against the host's declared contract set;
 * (3) computes a read-only structural compatibility report; (4) refuses structural
 * incompatibility; (5) re-reads authorities under the lock (every read here is
 * under it); (6-7) durably writes the new binding to a temp file and atomically
 * renames + fsyncs it; and (8) reports success ONLY after a fresh load resolves
 * the expected product. Known operational unreadiness (missing providers,
 * credentials, grants, backends, tools, adapters, certificates) does NOT block —
 * it becomes structured setup. Only an unsupported pack schema, an unrecognized
 * contract pin, an unloadable knowledge profile, or an invalid composition is a
 * STRUCTURAL REFUSAL. Activation writes ONLY `active-product.json`; it never
 * rewrites pages, settings, grants, providers, preparations, bundles, projections,
 * or adapters. A present legacy `profile.json` is refused up front so activation
 * never manufactures a product-authority conflict (design section 8.2 migration
 * ordering); deep corpus-migration planning is deferred to a later slice.
 */

import { acquireMutationLockBlocking } from "../../operation-bundles/lock-gate.js";
import { releaseLock } from "../../utils/lock.js";
import { parseOperationsPack } from "../../operations-packs/parse.js";
import { verifyCompositionLock } from "../../operations-packs/composition-lock.js";
import {
  MAX_COMPOSITION_LOCK_BYTES, MAX_KNOWLEDGE_PROFILE_BYTES, MAX_ROOT_OPERATIONS_PACK_BYTES,
} from "../constants.js";
import { readInstalledProductPackage } from "../packages/store.js";
import type { ProductPackageManifestV1, Sha256Digest } from "../types.js";
import { assessStructuralCompatibility } from "../compatibility.js";
import type { StructuralCompatibilityInputsV1 } from "../compatibility.js";
import {
  deriveBindingComponents, knowledgeProfileMemberPath, loadKnowledgeProfileMember, readStoredMemberText,
} from "./manifest-authority.js";
import { ProductActivationError } from "./problems.js";
import { resolveActiveProduct } from "./resolve.js";
import { profileJsonPresent, writeActiveProductBinding } from "./store.js";
import type { ActiveBindingWriteFaultsV1 } from "./store.js";
import { ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION } from "./types.js";
import type { ActiveProductBindingV1, PrincipalRefV1 } from "./types.js";
import type { WorkspaceOperationsPackV2 } from "../../operations-packs/types.js";

/** A schema-version sentinel no supported contract declares, so it always refuses. */
const UNSUPPORTED_SCHEMA = -1;

/** A digest sentinel the host's declared contract set never holds, so it always refuses. */
const UNRECOGNIZED_DIGEST = `sha256:${"0".repeat(64)}` as Sha256Digest;

/** A registry-version sentinel the host's declared contract set never holds. */
const UNRECOGNIZED_VERSION = "";

/** The pack-derived contract-pin subset of the compatibility inputs. */
type PackContractInputs = Pick<StructuralCompatibilityInputsV1,
  "packSchemaVersion" | "requiredKnowledgeProfileSchemaVersion" | "requiredOperationsPackSchemaVersion"
  | "requiredProviderContractDigest" | "requiredOrchestrationContractDigest" | "requiredMilestoneAContractDigest"
  | "requiredHostHandlerRegistryVersion" | "requiredHostHandlerRegistryDigest">;

/** Map a parsed pack's declared schema and contract requirements to compatibility inputs. */
function packContractInputs(pack: WorkspaceOperationsPackV2): PackContractInputs {
  const requires = pack.requires;
  return {
    packSchemaVersion: pack.schemaVersion,
    requiredKnowledgeProfileSchemaVersion: requires.knowledgeProfileSchemaVersion,
    requiredOperationsPackSchemaVersion: requires.operationsPackSchemaVersion,
    requiredProviderContractDigest: requires.providerContractDigest,
    requiredOrchestrationContractDigest: requires.orchestrationContractDigest,
    requiredMilestoneAContractDigest: requires.milestoneAContractDigest,
    requiredHostHandlerRegistryVersion: requires.hostHandlerRegistryVersion,
    requiredHostHandlerRegistryDigest: requires.hostHandlerRegistryDigest,
  };
}

/** The contract-pin inputs a pack that fails to parse reduces to: nothing recognized. */
const UNRECOGNIZED_CONTRACT_INPUTS: PackContractInputs = {
  packSchemaVersion: UNSUPPORTED_SCHEMA,
  requiredKnowledgeProfileSchemaVersion: UNSUPPORTED_SCHEMA,
  requiredOperationsPackSchemaVersion: UNSUPPORTED_SCHEMA,
  requiredProviderContractDigest: UNRECOGNIZED_DIGEST,
  requiredOrchestrationContractDigest: UNRECOGNIZED_DIGEST,
  requiredMilestoneAContractDigest: UNRECOGNIZED_DIGEST,
  requiredHostHandlerRegistryVersion: UNRECOGNIZED_VERSION,
  requiredHostHandlerRegistryDigest: UNRECOGNIZED_DIGEST,
};

/** Options for one activation: an explicit instant, detached certificate, faults. */
export interface ActivateProductOptionsV1 {
  /** Override the activation timestamp (defaults to now) for deterministic tests. */
  activatedAt?: string;
  /** Optional detached parity certificate digest (never authorizes an action). */
  parityCertificateDigest?: Sha256Digest;
  /** Test-only crash-fault seams for the durable binding write. */
  faults?: ActiveBindingWriteFaultsV1;
}

/** The settled outcome of one activation, reported only after a fresh readback. */
export interface ActivateResultV1 {
  status: "activated";
  productId: string;
  productVersion: string;
  packageDigest: Sha256Digest;
  binding: ActiveProductBindingV1;
  profileDigest: string;
}

/** Resolve the exact installed package offline, or refuse structurally. */
async function resolveInstalledManifest(
  root: string, packageDigest: Sha256Digest,
): Promise<ProductPackageManifestV1> {
  const pkg = await readInstalledProductPackage(root, packageDigest);
  if (pkg.status !== "ok") throw new ProductActivationError(`installed package is ${pkg.status}`);
  return pkg.manifest;
}

/** Refuse activation while a legacy profile.json would create a conflict. */
async function assertNoLegacyProfile(root: string): Promise<void> {
  if (await profileJsonPresent(root)) {
    throw new ProductActivationError("a legacy profile.json is present; run migration before activation");
  }
}

/** Whether the composition graph recomputes and its stored lock matches exactly. */
async function isCompositionValid(
  root: string, manifest: ProductPackageManifestV1, pack: WorkspaceOperationsPackV2,
): Promise<boolean> {
  try {
    const lockText = await readStoredMemberText(
      root, manifest.packageDigest, manifest.compositionLock, MAX_COMPOSITION_LOCK_BYTES);
    verifyCompositionLock(pack, lockText);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the operations-pack structural facts, refusing to sentinels on failure. */
async function readPackStructure(
  root: string, manifest: ProductPackageManifestV1,
): Promise<PackContractInputs & Pick<StructuralCompatibilityInputsV1, "compositionValid">> {
  let pack: WorkspaceOperationsPackV2;
  try {
    const opsText = await readStoredMemberText(
      root, manifest.packageDigest, manifest.rootOperationsPack, MAX_ROOT_OPERATIONS_PACK_BYTES);
    pack = parseOperationsPack(opsText);
  } catch {
    return { ...UNRECOGNIZED_CONTRACT_INPUTS, compositionValid: false };
  }
  return { ...packContractInputs(pack), compositionValid: await isCompositionValid(root, manifest, pack) };
}

/** Resolve the knowledge-profile structural facts, refusing to sentinels on failure. */
async function readProfileStructure(
  root: string, manifest: ProductPackageManifestV1,
): Promise<Pick<StructuralCompatibilityInputsV1, "knowledgeProfileSchemaVersion" | "knowledgeProfileLoadable">> {
  try {
    const kpText = await readStoredMemberText(
      root, manifest.packageDigest, manifest.knowledgeProfile, MAX_KNOWLEDGE_PROFILE_BYTES);
    const memberPath = knowledgeProfileMemberPath(root, manifest.packageDigest, manifest.knowledgeProfile.digest);
    const loaded = loadKnowledgeProfileMember(kpText, memberPath);
    return { knowledgeProfileSchemaVersion: loaded.profile.schemaVersion, knowledgeProfileLoadable: true };
  } catch {
    return { knowledgeProfileSchemaVersion: UNSUPPORTED_SCHEMA, knowledgeProfileLoadable: false };
  }
}

/** Gather every structural compatibility fact from the installed package. */
async function assessInstalledStructure(
  root: string, manifest: ProductPackageManifestV1,
): Promise<StructuralCompatibilityInputsV1> {
  return { ...(await readPackStructure(root, manifest)), ...(await readProfileStructure(root, manifest)) };
}

/** Build the new binding from the manifest, so its component digests are exact. */
function buildBinding(
  manifest: ProductPackageManifestV1, principal: PrincipalRefV1,
  activatedAt: string, parityCertificateDigest?: Sha256Digest,
): ActiveProductBindingV1 {
  const binding: ActiveProductBindingV1 = {
    schemaVersion: ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION,
    ...deriveBindingComponents(manifest),
    activatedAt,
    activatedBy: principal,
  };
  return parityCertificateDigest === undefined ? binding : { ...binding, parityCertificateDigest };
}

/** Report success only after a fresh load resolves the expected product mode. */
async function assertReadback(root: string, packageDigest: Sha256Digest): Promise<string> {
  const resolution = await resolveActiveProduct(root);
  if (resolution.mode !== "product" || resolution.binding.packageDigest !== packageDigest) {
    throw new ProductActivationError("activation did not resolve to the expected product on readback");
  }
  return resolution.loaded.digest;
}

/** Run the design section 8.3 activation steps under the already-acquired lock. */
async function activateUnderLock(
  root: string, packageDigest: Sha256Digest, principal: PrincipalRefV1, options: ActivateProductOptionsV1,
): Promise<ActivateResultV1> {
  const manifest = await resolveInstalledManifest(root, packageDigest);
  await assertNoLegacyProfile(root);
  const report = assessStructuralCompatibility(await assessInstalledStructure(root, manifest));
  if (!report.structurallyCompatible) {
    throw new ProductActivationError(`structural incompatibility: ${report.refusals.join("; ")}`);
  }
  const binding = buildBinding(
    manifest, principal, options.activatedAt ?? new Date().toISOString(), options.parityCertificateDigest);
  await writeActiveProductBinding(root, binding, options.faults);
  const profileDigest = await assertReadback(root, packageDigest);
  return {
    status: "activated", productId: binding.productId, productVersion: binding.productVersion,
    packageDigest: binding.packageDigest, binding, profileDigest,
  };
}

/**
 * Snapshot the caller's audit principal into a fresh frozen value BEFORE the first
 * await, so a later mutation of the caller's object cannot change the identity the
 * binding records. The binding uses ONLY this snapshot for `activatedBy`.
 */
function snapshotPrincipal(principal: PrincipalRefV1): PrincipalRefV1 {
  return Object.freeze({ id: principal.id, surface: principal.surface });
}

/**
 * Snapshot the caller's audit-relevant options synchronously BEFORE the first
 * await, so a later mutation of the caller's object cannot change the `activatedAt`
 * or `parityCertificateDigest` the binding persists. Only these copied primitives
 * (and the test-only fault seam) reach `activateUnderLock`.
 */
function snapshotOptions(options: ActivateProductOptionsV1): ActivateProductOptionsV1 {
  return Object.freeze({
    activatedAt: options.activatedAt,
    parityCertificateDigest: options.parityCertificateDigest,
    faults: options.faults,
  });
}

/**
 * Activate one installed product under the project lock and the recovery gate,
 * writing `active-product.json` only via a durable atomic rename and reporting
 * success only after a fresh load resolves the expected digests. The caller
 * supplies the exact `packageDigest` to activate and the audit principal, which is
 * snapshot synchronously here so the recorded identity is immune to later mutation.
 */
export async function activateProductLocked(
  root: string, packageDigest: Sha256Digest, principal: PrincipalRefV1,
  options: ActivateProductOptionsV1 = {},
): Promise<ActivateResultV1> {
  const auditPrincipal = snapshotPrincipal(principal);
  const auditOptions = snapshotOptions(options);
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    return await activateUnderLock(root, packageDigest, auditPrincipal, auditOptions);
  } finally {
    await releaseLock(root);
  }
}
