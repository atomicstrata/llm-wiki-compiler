/**
 * @file src/preparations/references.ts
 * @description Authoritative reference enumeration the preparation store emits for
 * workspace-operations-pack GC (WOP design section, and design section 24.4's
 * fail-closed read taxonomy). GC must never reclaim a product package or runtime
 * authority that a surviving preparation still references, so this module walks the
 * REAL preparation objects — the authenticated inventory manifests and their runs —
 * and reports every runtime-authority digest and product-package authority each one
 * binds. It is never a shadow index: every reference is derived from a validated
 * object read at enumeration time. It is fail-closed: an integrity-invalid or
 * unreadable owner, an inventory problem, or a pending destructive lifecycle unit
 * sets `complete: false` so GC conservatively holds, because an unreadable owner is
 * unavailable, never absent.
 */

import { scanPreparationInventoryFromLifecycle } from "./capacity.js";
import { readPreparationRun } from "./run-store.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "./manifest-parse.js";
import { snapshotHasPendingLifecycle } from "./lifecycle-snapshot/compat.js";
import {
  withPreparationLifecycleRead, type PreparationLifecycleReadV1,
} from "./lifecycle-snapshot/read.js";
import type { NormalizedPreparationPlanV1 } from "./plan-types.js";
import type { AuthorityRefV1 } from "./types.js";
import type { PreparationRunBinding } from "./run-types.js";

/** The runtime/product authorities one preparation object binds, plus its state. */
export interface PreparationReferenceV1 {
  workspaceId: string;
  preparationId: string;
  runId: string;
  state: string;
  runtimeAuthorityDigests: readonly string[];
  productAuthorities: readonly AuthorityRefV1[];
  handoffBundleId?: string;
}

/** The complete enumerated reference set consumed by product-package GC. */
export interface PreparationReferenceSetV1 {
  references: readonly PreparationReferenceV1[];
  complete: boolean;
  problems: readonly { dimension: string; detail: string }[];
}

/** Collect every runtime-authority digest a normalized plan binds. */
function planRuntimeAuthorityDigests(plan: NormalizedPreparationPlanV1): string[] {
  const digests = [
    plan.knowledgeAuthority.digest, plan.knowledgeAuthority.runtimeIdentityDigest,
    plan.operationsAuthority.digest, plan.operationsAuthority.runtimeIdentityDigest,
    plan.actionAuthority.actionDescriptorDigest, plan.actionAuthority.handlerContractDigest,
    plan.recipeDigest, plan.safetyFloorDigest,
  ];
  for (const phase of plan.phases) {
    if (phase.executor?.kind === "provider-capability") {
      digests.push(phase.executor.providerPinDigest, phase.executor.capabilityContractDigest);
    } else if (phase.executor?.kind === "host-handler") {
      digests.push(phase.executor.handlerContractDigest);
    }
  }
  return [...new Set(digests)].sort();
}

/**
 * The exact binding for one inventoried manifest under the current key epoch.
 *
 * EXPORTED because it is the one home for this construction. The identical
 * field list was hand-rolled in `recovery.ts`, `capacity.ts` and the new CLI
 * listing before this — four copies of an invariant that already had a named
 * helper here, which is the hand-written-scope-beside-a-derivable-one class.
 * Every lifecycle verb needs it, so it gets one home before the second caller
 * rather than after the fifth.
 */
export function bindingFor(manifest: PreparationManifestV1, keyEpochId: PreparationRunBinding["keyEpochId"]): PreparationRunBinding {
  return {
    runId: manifest.runId, preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
    manifestDigest: preparationManifestDigest(manifest), keyEpochId,
  };
}

interface ManifestReference { reference: PreparationReferenceV1; complete: boolean }

/** Resolve one manifest's run state into a reference, failing closed on faults. */
async function manifestReference(root: string, manifest: PreparationManifestV1, keyEpochId: PreparationRunBinding["keyEpochId"]): Promise<ManifestReference> {
  const base = {
    workspaceId: manifest.workspaceId, preparationId: manifest.preparationId, runId: manifest.runId,
    runtimeAuthorityDigests: planRuntimeAuthorityDigests(manifest.plan),
    productAuthorities: [{ ...manifest.plan.knowledgeAuthority }, { ...manifest.plan.operationsAuthority }],
  };
  const read = await readPreparationRun(root, bindingFor(manifest, keyEpochId));
  if (read.status === "ok") {
    return { complete: true, reference: { ...base, state: read.run.state, ...(read.run.handoff === undefined ? {} : { handoffBundleId: read.run.handoff.bundleId }) } };
  }
  if (read.status === "absent") return { complete: true, reference: { ...base, state: "orphan-run-absent" } };
  const state = read.code === "run-integrity-invalid" ? "integrity-invalid" : "unreadable";
  return { complete: false, reference: { ...base, state } };
}

/**
 * Enumerate the complete product-package/runtime-authority reference set from the
 * authenticated preparation inventory. `complete` is false whenever any owner could
 * not be safely read or a destructive lifecycle unit is still pending, so GC holds.
 */
export async function enumeratePreparationReferences(root: string): Promise<PreparationReferenceSetV1> {
  return withPreparationLifecycleRead(root, (read) => referencesFromLifecycle(root, read));
}

/**
 * Compose the whole reference decision from ONE supplied lifecycle read.
 *
 * Capacity and lifecycle pendingness previously captured separately, so the two
 * halves of a single answer observed different filesystem states and a unit that
 * settled between them was counted inconsistently within one decision.
 *
 * This moves the lifecycle observation point BEFORE the manifest enumeration loop
 * rather than after it, which is a deliberate coherence-over-recency trade: a
 * destructive unit created mid-enumeration is no longer caught by this call. The
 * previous ordering had the mirror hazard — it could report pendingness from a
 * state the inventory never saw — and only one of the two can hold. Callers that
 * need recency must re-decide.
 *
 * Stated as a limitation rather than a handled hazard: no caller of this function
 * exists in this repository, and nothing here enforces or names a lock around the
 * enumeration, so the trade is unmitigated in-repo. Recorded as Task 10 debt
 * beside the GC-locking question — if GC holds the project lock across the call
 * the trade is unobservable and needs nothing; if it does not, it needs a pin and
 * possibly a different design. Answer the lock question first.
 */
async function referencesFromLifecycle(
  root: string,
  read: PreparationLifecycleReadV1,
): Promise<PreparationReferenceSetV1> {
  const inventory = await scanPreparationInventoryFromLifecycle(root, read);
  const problems = inventory.problems.map((problem) => ({ dimension: problem.dimension, detail: problem.detail }));
  let complete = inventory.problems.length === 0;
  const references: PreparationReferenceV1[] = [];
  for (const manifest of inventory.manifests) {
    const resolved = await manifestReference(root, manifest, manifest.keyEpochId);
    references.push(resolved.reference);
    complete = complete && resolved.complete;
  }
  if (lifecyclePending(read)) { complete = false; problems.push({ dimension: "quarantine", detail: "a destructive lifecycle unit is pending" }); }
  references.sort((left, right) => `${left.workspaceId}/${left.runId}`.localeCompare(`${right.workspaceId}/${right.runId}`));
  return { references, complete, problems };
}

/**
 * True when either lifecycle registry is unfinished or unreadable. An unavailable
 * capture is pending by construction: no retry, and never a silent clean.
 */
function lifecyclePending(read: PreparationLifecycleReadV1): boolean {
  return read.status === "unavailable" || snapshotHasPendingLifecycle(read.snapshot);
}
