/**
 * @file src/operation-bundles/operations-authority-resolver.ts
 * @description The minimal host-owned production operations-authority resolver
 * (Milestone A, design v2 §14.1/§14.2 + the 2026-07-20 addendum). It recomputes
 * ALL twelve authority-snapshot components from authoritative current state and
 * folds them through {@link authoritySnapshotDigest}, so approve/apply/recovery
 * proceed when state is coherent and readable, genuine drift between approval and
 * recovery is detected (mismatched digest → the seam parks), and unreadable or
 * absent backing state fails closed with `{status:"unavailable"}`.
 *
 * INVARIANTS (see the addendum):
 *  - Never accept caller-supplied component digests. `manifestDigest`,
 *    `adapterCapabilityDigest`, and `keyEpochId` arrive on the request but are
 *    recomputed from source (the store-loaded manifest, the host adapter kinds
 *    closed over at construction, and the on-disk operation key) and the request
 *    copies are ignored.
 *  - Do NOT mint or widen grants. The resolver proves STATE only; authorization
 *    by grant stays enforced by the seams against `principal.grants`.
 *  - Every component is a deterministic pure function of state that is stable
 *    across a crash window for an unchanged bundle. No volatile/global data
 *    (inventory contents, timestamps, principal identity) is folded — only the
 *    store-health VERDICT, never its changing contents.
 *  - `operationsAuthorityDigest`/`actionDescriptorDigest`/`safetyFloorDigest`
 *    have no host policy subsystem in Milestone A, so each is a fixed,
 *    domain-separated "not configured" constant. The manifest's declared refs are
 *    ignored here (they are already bound by `manifestDigest`, which folds the
 *    whole manifest); local-operator authority (§14.2) is the governing control.
 *  - `storeHealthDigest` is a fixed host-owned constant. Milestone A exposes no
 *    per-bundle store-health snapshot; the only signal is the project-global
 *    inventory scan, whose verdict flips whenever ANY unrelated bundle or
 *    workspace is degraded — folding it would drift an unchanged bundle's snapshot
 *    on unrelated crash debris and FALSE-PARK its recovery (the D13 soft-brick).
 *    The real store-health gate is per-mutation adapter revalidation at
 *    apply/recovery time (design v2 §15 step 2), which still parks a genuinely
 *    sick target; a constant here loses no safety and removes the false-park.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { loadProfile } from "../profile/load.js";
import {
  authoritySnapshotDigest,
  type AuthoritySnapshotRequest,
  type AuthoritySnapshotResult,
  type OperationAuthorityProvider,
  type OperationAuthoritySnapshot,
} from "./authority.js";
import { readOperationKey } from "./key-epoch.js";
import { operationManifestDigest } from "./manifest-parse.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationBundleManifest, OperationDigest, OperationMutation } from "./types.js";

/** Construction inputs: the host adapter kinds whose capability identity is bound. */
export interface OperationsAuthorityResolverOptions {
  /** The real host adapter kinds (the runtime's adapter-map keys). */
  adapterKinds: readonly string[];
}

/**
 * The fixed store-health identity: Milestone A has no per-bundle store-health
 * signal, and store health is gated per-mutation by adapter revalidation (§15
 * step 2), so this component is a stable host-owned constant that never
 * false-parks recovery on unrelated store churn.
 */
const STORE_HEALTH_DIGEST = canonicalDigest({
  component: "storeHealth", gatedBy: "adapter-revalidation",
}) as OperationDigest;

/** Recompute the manifest identity from the store-loaded manifest, not the request. */
function recomputeManifestDigest(manifest: OperationBundleManifest): OperationDigest {
  return operationManifestDigest(manifest) as OperationDigest;
}

/** Recompute the resource-bound identity from the inline (immutable) manifest bounds. */
function recomputeBoundsDigest(manifest: OperationBundleManifest): OperationDigest {
  return canonicalDigest(manifest.bounds) as OperationDigest;
}

/** The declared payload ref of one mutation, or undefined for kinds that carry none. */
function payloadRefOf(mutation: OperationMutation): string | undefined {
  return "payloadRef" in mutation ? mutation.payloadRef : undefined;
}

/**
 * Recompute the payload-set identity over the manifest's DECLARED payload refs —
 * every input digest plus every per-mutation payload ref — canonically ordered so
 * the value is a stable function of the immutable manifest, not of array order.
 */
function recomputePayloadSetDigest(manifest: OperationBundleManifest): OperationDigest {
  const inputDigests = manifest.inputs.map((input) => input.digest).slice().sort();
  const payloadRefs = manifest.mutations
    .map(payloadRefOf)
    .filter((ref): ref is string => ref !== undefined)
    .sort();
  return canonicalDigest({ inputDigests, payloadRefs }) as OperationDigest;
}

/**
 * Recompute the precondition identity over the ordered per-mutation DECLARED
 * precondition tuples (inline on the immutable manifest). This is NOT a live
 * target evaluation — read-time precondition freshness is the separate §14.3
 * check, unchanged.
 */
function recomputePreconditionDigest(manifest: OperationBundleManifest): OperationDigest {
  const tuples = manifest.mutations.map((mutation) => ({
    mutationId: mutation.mutationId,
    precondition: mutation.precondition,
  }));
  return canonicalDigest(tuples) as OperationDigest;
}

/**
 * Recompute the grant identity over the presented principal's grants (sorted and
 * deduped). Binds the snapshot to the exact grant set; a different grant set
 * drifts (correct). Principal id/surface are deliberately NOT folded — authority
 * is by grant, not identity (§14.2).
 */
export function recomputeGrantDigest(principal: OperationPrincipal): OperationDigest {
  const grants = [...new Set(principal.grants)].sort();
  return canonicalDigest(grants) as OperationDigest;
}

/**
 * Recompute the adapter-capability identity from the host adapter kinds closed
 * over at construction (sorted), never from `request.adapterCapabilityDigest`.
 * Mirrors the executor's fold so the recorded and recomputed values agree.
 */
function recomputeAdapterCapabilityDigest(adapterKinds: readonly string[]): OperationDigest {
  return canonicalDigest([...adapterKinds].sort()) as OperationDigest;
}

/**
 * Stamp one host-owned, domain-separated "not configured" constant for a policy
 * subsystem that has no resolver/registry in Milestone A. The distinct `component`
 * domain keeps the three constants distinct and never collides with a real digest.
 */
function notConfiguredDigest(component: string): OperationDigest {
  return canonicalDigest({ component, configured: false }) as OperationDigest;
}

/**
 * Recompute the key-epoch id from the on-disk operation key (never the request
 * copy). Returns null — a fail-closed signal — when the key is absent or
 * unreadable, so an in-flight bundle cannot settle on an unproven key.
 */
async function recomputeKeyEpochId(root: string): Promise<OperationDigest | null> {
  const key = await readOperationKey(root);
  return key.status === "ok" ? key.keyEpochId : null;
}

/**
 * Recompute the active profile identity for the workspace. `loadProfile` yields
 * the built-in default for a clean project (loadable) and throws only for a
 * PRESENT-but-broken profile — which fails closed (null), because the profile
 * governs the workspace and must not be guessed.
 */
async function recomputeProfileDigest(root: string): Promise<OperationDigest | null> {
  try {
    const loaded = await loadProfile(root);
    return `sha256:${loaded.digest}` as OperationDigest;
  } catch {
    return null;
  }
}

/** The manifest-derived components plus the three not-configured constants. */
interface DerivedComponents {
  manifestDigest: OperationDigest;
  boundsDigest: OperationDigest;
  payloadSetDigest: OperationDigest;
  preconditionDigest: OperationDigest;
  grantDigest: OperationDigest;
  adapterCapabilityDigest: OperationDigest;
}

/** Recompute every synchronous (manifest/grant/adapter) component from source. */
function deriveSyncComponents(
  request: AuthoritySnapshotRequest,
  adapterKinds: readonly string[],
): DerivedComponents {
  return {
    manifestDigest: recomputeManifestDigest(request.manifest),
    boundsDigest: recomputeBoundsDigest(request.manifest),
    payloadSetDigest: recomputePayloadSetDigest(request.manifest),
    preconditionDigest: recomputePreconditionDigest(request.manifest),
    grantDigest: recomputeGrantDigest(request.principal),
    adapterCapabilityDigest: recomputeAdapterCapabilityDigest(adapterKinds),
  };
}

/** The state-backed components that can fail closed (absent/unreadable → null). */
interface StateComponents {
  keyEpochId: OperationDigest;
  profileDigest: OperationDigest;
}

/** Assemble the exact twelve-component snapshot object in the closed component set. */
function assembleSnapshot(sync: DerivedComponents, state: StateComponents): OperationAuthoritySnapshot {
  return {
    profileDigest: state.profileDigest,
    operationsAuthorityDigest: notConfiguredDigest("operationsAuthority"),
    actionDescriptorDigest: notConfiguredDigest("actionDescriptor"),
    grantDigest: sync.grantDigest,
    safetyFloorDigest: notConfiguredDigest("safetyFloor"),
    manifestDigest: sync.manifestDigest,
    payloadSetDigest: sync.payloadSetDigest,
    boundsDigest: sync.boundsDigest,
    adapterCapabilityDigest: sync.adapterCapabilityDigest,
    keyEpochId: state.keyEpochId,
    storeHealthDigest: STORE_HEALTH_DIGEST,
    preconditionDigest: sync.preconditionDigest,
  };
}

/** Read the two fail-closable state components, or the first unavailable reason. */
async function readStateComponents(root: string): Promise<StateComponents | { unavailable: string }> {
  const keyEpochId = await recomputeKeyEpochId(root);
  if (keyEpochId === null) return { unavailable: "operation key is absent or unreadable" };
  const profileDigest = await recomputeProfileDigest(root);
  if (profileDigest === null) return { unavailable: "active profile could not be loaded" };
  return { keyEpochId, profileDigest };
}

/**
 * Compute one authority snapshot for a request by recomputing all twelve
 * components from authoritative current state. Fail-closed and never throwing:
 * any unreadable backing state or malformed manifest yields `unavailable`.
 */
async function computeSnapshot(
  request: AuthoritySnapshotRequest,
  adapterKinds: readonly string[],
): Promise<AuthoritySnapshotResult> {
  try {
    const state = await readStateComponents(request.root);
    if ("unavailable" in state) return { status: "unavailable", reason: state.unavailable };
    const snapshot = assembleSnapshot(deriveSyncComponents(request, adapterKinds), state);
    return { status: "ok", snapshot, digest: authoritySnapshotDigest(snapshot) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", reason: `operation authority recompute failed: ${detail}` };
  }
}

/**
 * Build the minimal production operations-authority resolver. It closes over the
 * host adapter kinds (so the adapter-capability component is recomputed from the
 * real host adapter set, never trusted from the request) and holds no other
 * global state; every read is scoped to the request's root.
 *
 * @param options - The host adapter kinds whose capability identity is bound.
 * @returns An {@link OperationAuthorityProvider} with a pure `computeSnapshot`.
 */
export function createOperationsAuthorityResolver(
  options: OperationsAuthorityResolverOptions,
): OperationAuthorityProvider {
  const adapterKinds = [...options.adapterKinds];
  return { computeSnapshot: (request) => computeSnapshot(request, adapterKinds) };
}
