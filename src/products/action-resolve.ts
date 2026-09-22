/**
 * @file src/products/action-resolve.ts
 * @description Turn "the caller invoked this token in this project" into ONE
 * compiled, runnable pack action — the authority half of the product service
 * (design sections 8.2, 11.2, 15.1).
 *
 * EVERY AUTHORITY FIELD THE COMPILER TAKES IS SOURCED, NOT SYNTHESIZED. The
 * compiler is explicit that it derives no authority from the host and copies
 * whatever the caller hands it, so this is the module where a fabricated digest
 * would become a signed plan. Each field's provenance:
 *
 *  - `binding` — from {@link resolveActiveProduct}, the ONE resolver every
 *    surface authorizes against. Nothing here reads `active-product.json`.
 *  - `pack` — the installed root operations-pack MEMBER, read through the
 *    hardened confined reader and re-digested against the manifest's member
 *    reference, then parsed by the production parser.
 *  - `knowledgeRuntimeIdentityDigest` — the digest of the VALIDATED knowledge
 *    profile the resolver loaded from the package. Deliberately NOT
 *    `binding.knowledgeProfileDigest`: that is the member FILE's content
 *    address, while the runtime identity is over the canonical profile VALUE, so
 *    two byte-different serializations of one profile share a runtime identity.
 *  - `operationsRuntimeIdentityDigest` — the composition lock's `graphDigest`,
 *    INDEPENDENTLY RECOMPUTED here and required to equal the installed lock
 *    member. It binds the root pack, the member table and the flattened export
 *    table, which is the identity of what actually executes; the member file's
 *    own digest is again a different question, already carried as `digest`.
 *  - `safetyFloorDigest` — the host constant
 *    {@link PRODUCT_SAFETY_FLOOR_DIGEST}. Never a parameter, never per call.
 *  - `actionId` / `requestedSurface` — {@link resolveActionToken}, from the
 *    composed export table and the caller's own transport.
 *  - `workspaceId` / `input` — the CALLER's, and the only two that are. Neither
 *    carries authority: the workspace names where the run is recorded, and the
 *    input is sealed into immutable evidence the plan binds by digest.
 *
 * THE COMPOSITION LOCK IS RE-VERIFIED AT INVOCATION, not trusted from
 * activation. Activation proved the graph once; a package resolving today must
 * still recompute to the same graph, and the recomputation is where the digest
 * this run is sealed against comes from.
 *
 * IT NEVER FALLS BACK TO LEGACY. Every non-product mode — legacy, conflict,
 * unavailable — is a refusal carrying which one it was.
 */

import { parseSha256Digest } from "../capability-providers/ids.js";
import { resolveActionToken, type ActionTokenRouteV1 } from "../operations-packs/aliases.js";
import { verifyCompositionLock } from "../operations-packs/composition-lock.js";
import { compilePackAction } from "../operations-packs/compiler.js";
import { captureSourceEvidenceInput } from "./source-evidence-capture.js";
import { captureArtifactEvidenceInput } from "./artifact-evidence-capture.js";
import { capturePageEvidenceInput } from "./page-evidence-capture.js";
import type { CompiledPackActionV1 } from "../operations-packs/compiler-types.js";
import { parseOperationsPack } from "../operations-packs/parse.js";
import type { ProviderRequirementV2, WorkspaceContractV2 } from "../operations-packs/types.js";
import {
  CompositionLockError, PackDeferredError, PackIdentityError, PackParseError,
} from "../operations-packs/problems.js";
import type {
  CompositionLockV1, InvocationSurfaceV1, PackActionInputValueV2, WorkspaceOperationsPackV2,
} from "../operations-packs/types.js";
import type { LoadedProfile } from "../profile/types.js";
import type { Sha256Digest } from "../capability-providers/types.js";
import type { WorkflowParentRefV1 } from "../preparations/types.js";
import { readStoredMemberText } from "./binding/manifest-authority.js";
import { ProductBindingError } from "./binding/problems.js";
import { resolveActiveProduct, type ActiveProductResolution } from "./binding/resolve.js";
import type { ActiveProductBindingV1 } from "./binding/types.js";
import {
  MAX_COMPOSITION_LOCK_BYTES, MAX_ROOT_OPERATIONS_PACK_BYTES, PRODUCT_SAFETY_FLOOR_DIGEST,
} from "./constants.js";
import { readInstalledProductPackage } from "./packages/store.js";
import type { ProductPackageManifestV1 } from "./types.js";

/** The active-product resolution arm that carries a usable binding. */
type ActiveProductModeV1 = Extract<ActiveProductResolution, { mode: "product" }>;

/**
 * The domain classes whose throws mean "this invocation cannot proceed", never
 * "this broke partway" — the same fail-closed allowlist discipline the staging
 * operation uses. An I/O fault is not on it and stays visible.
 */
const RESOLUTION_REFUSALS = [
  PackIdentityError, PackParseError, PackDeferredError, CompositionLockError, ProductBindingError,
] as const;

/** What the caller named, plus the transport their surface actually is. */
export interface ProductActionRequestV1 {
  readonly workspaceId: string;
  readonly token: string;
  readonly surface: InvocationSurfaceV1;
  readonly input: Readonly<Record<string, PackActionInputValueV2>>;
  /** OPTIONAL outer-workflow parent, grafted into the canonical plan (P6). */
  readonly workflowParent?: WorkflowParentRefV1;
}

/** One compiled action and the authority it was compiled under. */
export interface ResolvedProductActionV1 {
  readonly binding: ActiveProductBindingV1;
  readonly compiled: CompiledPackActionV1;
  readonly route: ActionTokenRouteV1;
  readonly requestedSurface: InvocationSurfaceV1;
}

/** The closed outcome of resolving one product invocation. */
export type ProductActionResolutionV1 =
  | { readonly status: "resolved"; readonly action: ResolvedProductActionV1 }
  | { readonly status: "refused"; readonly reason: string };

/** The verified pack and the authoritative graph it independently recomputes to. */
interface PackAuthorityV1 {
  readonly pack: WorkspaceOperationsPackV2;
  readonly lock: CompositionLockV1;
}

/** Build one refusal. */
function refused(reason: string): ProductActionResolutionV1 {
  return { status: "refused", reason };
}

/** Say which non-product mode refused, without ever degrading to legacy. */
function modeRefusal(resolution: ActiveProductResolution): string {
  if (resolution.mode === "unavailable") return `the active product is unavailable: ${resolution.detail}`;
  if (resolution.mode === "conflict") {
    return "a product binding and a legacy profile.json both exist; neither is authoritative";
  }
  return "no product is active in this project; product actions require an activated product";
}

/**
 * Read the installed operations-pack and composition-lock members and prove the
 * graph. Both reads go through the hardened member reader, which re-verifies
 * each leaf's byte count and content digest against the manifest.
 */
async function readPackAuthority(
  root: string, manifest: ProductPackageManifestV1,
): Promise<PackAuthorityV1> {
  const packText = await readStoredMemberText(
    root, manifest.packageDigest, manifest.rootOperationsPack, MAX_ROOT_OPERATIONS_PACK_BYTES);
  const pack = parseOperationsPack(packText);
  const lockText = await readStoredMemberText(
    root, manifest.packageDigest, manifest.compositionLock, MAX_COMPOSITION_LOCK_BYTES);
  return { pack, lock: verifyCompositionLock(pack, lockText) };
}

/**
 * The installed knowledge authority's runtime identity: the digest of the
 * VALIDATED profile value, which `loadProfile` and every read surface already
 * treat as that profile's durable identity.
 */
function knowledgeRuntimeIdentity(loaded: LoadedProfile): Sha256Digest {
  return parseSha256Digest(`sha256:${loaded.digest}`);
}

/** Resolve the token against the proven graph and compile the named action. */
async function compileResolved(
  root: string, request: ProductActionRequestV1,
  active: ActiveProductModeV1, manifest: ProductPackageManifestV1,
): Promise<ProductActionResolutionV1> {
  const { pack, lock } = await readPackAuthority(root, manifest);
  const token = resolveActionToken({
    pack,
    composed: {
      rootPackDigest: lock.rootPackDigest, members: lock.members, resolvedExports: lock.resolvedExports,
    },
    token: request.token, surface: request.surface,
  });
  if (token.status === "refused") return refused(`invocation token refused (${token.code}): ${token.detail}`);
  // HOST-SIDE CAPTURE (spec §4.1.4): callers supply source-evidence PATHS only;
  // the host computes the digest and byte-count columns here and OVERWRITES any
  // supplied values — a caller-supplied digest is an assertion about bytes the
  // caller does not own, and sealing one would defeat the run-time drift check
  // exactly when it matters. The pure compiler then seals what the host read.
  const captured = await captureSourceEvidenceInput(root, pack, token.actionId, request.input);
  if ("refused" in captured) return refused(captured.refused);
  // The artifact-evidence sibling: capture-time verification + host-owned
  // member columns for an action whose provider phase reads a member-bearing
  // artifact (an unhealthy/unpinned ref refuses BEFORE staging — §5a leg one).
  const artifactCaptured = await captureArtifactEvidenceInput(root, pack, token.actionId, captured.input);
  if ("refused" in artifactCaptured) return refused(artifactCaptured.refused);
  // The page-evidence sibling (P5c §2a): host-DERIVED values from the page
  // the action targets — never caller input — sealed under capture-owned
  // keys, with capture-time verification (§5a leg one; the runtime rehash is
  // leg two).
  const pageCaptured = await capturePageEvidenceInput(root, pack, token.actionId, artifactCaptured.input);
  if ("refused" in pageCaptured) return refused(pageCaptured.refused);
  const compiled = await compilePackAction({
    workspaceId: request.workspaceId, binding: active.binding, pack,
    actionId: token.actionId, requestedSurface: token.requestedSurface, input: pageCaptured.input,
    knowledgeRuntimeIdentityDigest: knowledgeRuntimeIdentity(active.loaded),
    operationsRuntimeIdentityDigest: lock.graphDigest,
    safetyFloorDigest: PRODUCT_SAFETY_FLOOR_DIGEST,
    ...(request.workflowParent === undefined ? {} : { workflowParent: request.workflowParent }),
  });
  const contractRefusal = productContractRefusal(compiled, active);
  if (contractRefusal !== null) return refused(contractRefusal);
  return {
    status: "resolved",
    action: {
      binding: active.binding, compiled, route: token.route, requestedSurface: token.requestedSurface,
    },
  };
}

/**
 * The product-contract refusals a compiled action hits AFTER it compiles: a recipe
 * this surface cannot drive to a terminal, or a target the active product's own
 * profile never declared. Returned as a reason, or null when the action is
 * admissible on both — checked here, before any run stages, because both are
 * properties of the compiled plan against the installed product rather than of
 * the run.
 */
function productContractRefusal(compiled: CompiledPackActionV1, active: ActiveProductModeV1): string | null {
  // A gated recipe is DRIVEN now, not refused: `invoke` reports `awaiting-review`
  // when the run suspends at its gate, and `resume` re-drives the SAME run once
  // an operator has answered. The surface used to decline because it staged a
  // fresh run per call and had no route back; that route exists.
  return targetEntityRefusal(compiled, active);
}

/**
 * Refuse a target the active product cannot hold. The obligation authors a page
 * CREATE for the action's target entity type, and the page adapter resolves that
 * to `wiki/<entityType>/<slug>.md` — so two things must hold, or the bundle would
 * propose a write outside its own product's declared storage (WOP design v3 §12.4
 * requires a referenced profile entity to be validated against the ACTIVE
 * profile). First the type must be declared; second its declared directory must
 * be the exact `wiki/<entityType>` namespace the adapter writes, because a
 * profile that stores that entity ELSEWHERE cannot be honored by this create.
 * Both are checked before any run stages; a directory-routed create is a later
 * unit, not something to fake here. `entities` is validated host data (plain,
 * accessor-free), so an own-key read is a data read.
 */
function targetEntityRefusal(compiled: CompiledPackActionV1, active: ActiveProductModeV1): string | null {
  const entities = active.loaded.profile.entities;
  for (const targetType of compiled.materializationSpec.pageProfileClasses) {
    if (!Object.hasOwn(entities, targetType)) {
      return "this action targets an entity type the active product's knowledge profile does not declare";
    }
    if (entities[targetType]?.directory !== `wiki/${targetType}`) {
      return "this action's target entity is declared under a directory this product surface cannot write; its page create writes wiki/<entity-type>";
    }
  }
  return null;
}

/**
 * Resolve one product invocation to a compiled, runnable action.
 *
 * @param root - The project root the invocation acts within.
 * @param request - The workspace, the invocation token, the caller's transport,
 *   and the caller's declared action input.
 * @returns The compiled action and its authority, or the honest refusal. Reading
 *   or compiling failures inside the pack contract become refusals; an
 *   operational fault is rethrown and stays visible.
 */
/** What a readiness review needs: the active pack's contract, or why not. */
export type ActiveWorkspaceContractV1 =
  | {
    readonly status: "ok"; readonly contract: WorkspaceContractV2; readonly packId: string;
    /** Declared provider requirements, so a review can check what backs a dimension. */
    readonly providerRequirements: readonly ProviderRequirementV2[];
  }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Resolve the ACTIVE product's workspace contract for a read-only review.
 *
 * It reuses `readPackAuthority` rather than reading the pack a second way, so a
 * review can never describe a different pack than the one actions compile from
 * — the composition lock is verified on this path too.
 *
 * @param root - The project root to resolve within.
 */
export async function resolveActiveWorkspaceContract(
  root: string,
): Promise<ActiveWorkspaceContractV1> {
  const resolution = await resolveActiveProduct(root);
  if (resolution.mode !== "product") return { status: "refused", reason: modeRefusal(resolution) };
  const pkg = await readInstalledProductPackage(root, resolution.binding.packageDigest);
  if (pkg.status !== "ok") return { status: "refused", reason: `the installed product package is ${pkg.status}` };
  try {
    const authority = await readPackAuthority(root, pkg.manifest);
    return {
      status: "ok", contract: authority.pack.workspaceContract, packId: authority.pack.packId,
      providerRequirements: authority.pack.providerRequirements,
    };
  } catch (error) {
    if (!RESOLUTION_REFUSALS.some((klass) => error instanceof klass)) throw error;
    return { status: "refused", reason: `the product package could not be read: ${(error as Error).message}` };
  }
}

export async function resolveProductAction(
  root: string, request: ProductActionRequestV1,
): Promise<ProductActionResolutionV1> {
  const resolution = await resolveActiveProduct(root);
  if (resolution.mode !== "product") return refused(modeRefusal(resolution));
  const pkg = await readInstalledProductPackage(root, resolution.binding.packageDigest);
  if (pkg.status !== "ok") return refused(`the installed product package is ${pkg.status}`);
  try {
    return await compileResolved(root, request, resolution, pkg.manifest);
  } catch (error) {
    if (!RESOLUTION_REFUSALS.some((klass) => error instanceof klass)) throw error;
    return refused(`the product action could not be compiled: ${(error as Error).message}`);
  }
}
