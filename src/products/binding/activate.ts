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
 *
 * ONE BODY: {@link activateUnderLockWith} keeps steps (1)-(8) and every refusal
 * over {@link ProductActivationSteps}. {@link activateProductLocked} keeps its
 * signature, snapshots the principal and options BEFORE awaiting the lock, and
 * passes {@link localProductActivationSteps}, whose members call the incumbent
 * package, member, profile, binding and resolution functions when asked.
 */

import { acquireMutationLockBlocking } from "../../operation-bundles/lock-gate.js";
import { releaseLock } from "../../utils/lock.js";
import { parseOperationsPack } from "../../operations-packs/parse.js";
import { verifyCompositionLock } from "../../operations-packs/composition-lock.js";
import {
  MAX_COMPOSITION_LOCK_BYTES, MAX_KNOWLEDGE_PROFILE_BYTES, MAX_ROOT_OPERATIONS_PACK_BYTES,
} from "../constants.js";
import { readInstalledProductPackage, type VerifiedMemberBytes } from "../packages/store.js";
import type { PackageMemberRefV1, ProductPackageManifestV1, Sha256Digest } from "../types.js";
import type { LoadedProfile } from "../../profile/types.js";
import { assessStructuralCompatibility } from "../compatibility.js";
import type { StructuralCompatibilityInputsV1 } from "../compatibility.js";
import {
  deriveBindingComponents, knowledgeProfileMemberPath, loadKnowledgeProfileMember, readStoredMemberText,
  verifiedMemberText,
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

/** What activation asks of the project, under the caller's lock. No member takes a project root. */
export interface ProductActivationSteps {
  /** The exact installed package, read offline. */
  readInstalledPackage(packageDigest: Sha256Digest): ReturnType<typeof readInstalledProductPackage>;
  /** Whether a legacy `profile.json` is present beside the binding. */
  profileJsonPresent(): Promise<boolean>;
  /** One installed member's text, strictly decoded within `maxBytes`; rejects on any fault. */
  readMemberText(packageDigest: Sha256Digest, member: PackageMemberRefV1, maxBytes: number): Promise<string>;
  /** Load the knowledge-profile member text as the installed member it is; rejects when unloadable. */
  loadKnowledgeProfile(packageDigest: Sha256Digest, memberDigest: Sha256Digest, text: string): LoadedProfile;
  /** Durably write the new binding (the fault seams pass through). */
  writeBinding(binding: ActiveProductBindingV1, faults?: ActiveBindingWriteFaultsV1): Promise<void>;
  /** A fresh resolution of the active product. */
  resolveActive(): ReturnType<typeof resolveActiveProduct>;
}

/** LOCAL DISK: the incumbent functions for one root, built per call, each called when asked. In no package index. */
export function localProductActivationSteps(root: string): ProductActivationSteps {
  return {
    readInstalledPackage: (packageDigest) => readInstalledProductPackage(root, packageDigest),
    profileJsonPresent: () => profileJsonPresent(root),
    readMemberText: (packageDigest, member, maxBytes) => readStoredMemberText(root, packageDigest, member, maxBytes),
    loadKnowledgeProfile: (packageDigest, memberDigest, text) =>
      loadKnowledgeProfileMember(text, knowledgeProfileMemberPath(root, packageDigest, memberDigest)),
    writeBinding: (binding, faults) => writeActiveProductBinding(root, binding, faults),
    resolveActive: () => resolveActiveProduct(root),
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

/** The exact installed package as its offline read verified it: the manifest and the member bytes it kept. */
interface InstalledPackageV1 {
  readonly manifest: ProductPackageManifestV1;
  readonly verifiedMembers: VerifiedMemberBytes;
}

/** Resolve the exact installed package offline, or refuse structurally. */
async function resolveInstalledPackage(
  steps: ProductActivationSteps, packageDigest: Sha256Digest,
): Promise<InstalledPackageV1> {
  const pkg = await steps.readInstalledPackage(packageDigest);
  if (pkg.status !== "ok") throw new ProductActivationError(`installed package is ${pkg.status}`);
  return { manifest: pkg.manifest, verifiedMembers: pkg.verifiedMembers };
}

/**
 * One member's text, under the lock: the bytes the package read just verified
 * when it kept them, otherwise the member reader. Either rejects on any fault.
 */
async function installedMemberText(
  steps: ProductActivationSteps, installed: InstalledPackageV1, member: PackageMemberRefV1, maxBytes: number,
): Promise<string> {
  return verifiedMemberText(installed.verifiedMembers, member, maxBytes)
    ?? steps.readMemberText(installed.manifest.packageDigest, member, maxBytes);
}

/** Refuse activation while a legacy profile.json would create a conflict. */
async function assertNoLegacyProfile(steps: ProductActivationSteps): Promise<void> {
  if (await steps.profileJsonPresent()) {
    throw new ProductActivationError("a legacy profile.json is present; run migration before activation");
  }
}

/** Whether the composition graph recomputes and its stored lock matches exactly. */
async function isCompositionValid(
  steps: ProductActivationSteps, installed: InstalledPackageV1, pack: WorkspaceOperationsPackV2,
): Promise<boolean> {
  try {
    const lockText = await installedMemberText(steps, installed, installed.manifest.compositionLock, MAX_COMPOSITION_LOCK_BYTES);
    verifyCompositionLock(pack, lockText);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the operations-pack structural facts, refusing to sentinels on failure. */
async function readPackStructure(
  steps: ProductActivationSteps, installed: InstalledPackageV1,
): Promise<PackContractInputs & Pick<StructuralCompatibilityInputsV1, "compositionValid">> {
  let pack: WorkspaceOperationsPackV2;
  try {
    const opsText = await installedMemberText(steps, installed, installed.manifest.rootOperationsPack, MAX_ROOT_OPERATIONS_PACK_BYTES);
    pack = parseOperationsPack(opsText);
  } catch {
    return { ...UNRECOGNIZED_CONTRACT_INPUTS, compositionValid: false };
  }
  return { ...packContractInputs(pack), compositionValid: await isCompositionValid(steps, installed, pack) };
}

/** Resolve the knowledge-profile structural facts, refusing to sentinels on failure. */
async function readProfileStructure(
  steps: ProductActivationSteps, installed: InstalledPackageV1,
): Promise<Pick<StructuralCompatibilityInputsV1, "knowledgeProfileSchemaVersion" | "knowledgeProfileLoadable">> {
  const { manifest } = installed;
  try {
    const kpText = await installedMemberText(steps, installed, manifest.knowledgeProfile, MAX_KNOWLEDGE_PROFILE_BYTES);
    const loaded = steps.loadKnowledgeProfile(manifest.packageDigest, manifest.knowledgeProfile.digest, kpText);
    return { knowledgeProfileSchemaVersion: loaded.profile.schemaVersion, knowledgeProfileLoadable: true };
  } catch {
    return { knowledgeProfileSchemaVersion: UNSUPPORTED_SCHEMA, knowledgeProfileLoadable: false };
  }
}

/** Gather every structural compatibility fact from the installed package. */
async function assessInstalledStructure(
  steps: ProductActivationSteps, installed: InstalledPackageV1,
): Promise<StructuralCompatibilityInputsV1> {
  return { ...(await readPackStructure(steps, installed)), ...(await readProfileStructure(steps, installed)) };
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
async function assertReadback(steps: ProductActivationSteps, packageDigest: Sha256Digest): Promise<string> {
  const resolution = await steps.resolveActive();
  if (resolution.mode !== "product" || resolution.binding.packageDigest !== packageDigest) {
    throw new ProductActivationError("activation did not resolve to the expected product on readback");
  }
  return resolution.loaded.digest;
}

/** Run the design section 8.3 activation steps under the already-acquired lock. */
export async function activateUnderLockWith(
  steps: ProductActivationSteps, packageDigest: Sha256Digest, principal: PrincipalRefV1, options: ActivateProductOptionsV1,
): Promise<ActivateResultV1> {
  const installed = await resolveInstalledPackage(steps, packageDigest);
  const { manifest } = installed;
  await assertNoLegacyProfile(steps);
  const report = assessStructuralCompatibility(await assessInstalledStructure(steps, installed));
  if (!report.structurallyCompatible) {
    throw new ProductActivationError(`structural incompatibility: ${report.refusals.join("; ")}`);
  }
  const binding = buildBinding(
    manifest, principal, options.activatedAt ?? new Date().toISOString(), options.parityCertificateDigest);
  await steps.writeBinding(binding, options.faults);
  const profileDigest = await assertReadback(steps, packageDigest);
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
    return await activateUnderLockWith(localProductActivationSteps(root), packageDigest, auditPrincipal, auditOptions);
  } finally {
    await releaseLock(root);
  }
}
