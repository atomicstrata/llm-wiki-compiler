/**
 * @file src/operation-bundles/bundle-target.ts
 * @description Resolving one OPERATOR-NAMED bundle target — a run id or a bundle
 * id a human typed — to the durable identities an approve/apply/recovery request
 * is built from.
 *
 * IT LIVES IN THE DOMAIN RATHER THAN IN A COMMAND because two surfaces now name a
 * bundle: the `operation` recovery-drive group and `product apply`. The lookup
 * rule (a target matches a run id OR a bundle id) and the digest rule (a manifest
 * never stores its own digest, so every binding recomputes it the same way) have
 * to be ONE rule. Two copies is how one surface comes to accept a target the
 * other refuses, or to bind a request to a digest the executor then rejects.
 *
 * NOTHING HERE IS FABRICATED, which is the whole point of routing both surfaces
 * through it. `workspaceId`, `bundleId` and `runId` are read off the manifest the
 * store loaded, and `manifestDigest` is recomputed from those same bytes by the
 * shared fold. A caller that guessed any of them would be refused by the
 * executor's own digest check; this module is why it never has to.
 */

import { scanOperationInventory, type OperationInventory } from "./capacity.js";
import { operationManifestDigest } from "./manifest-parse.js";
import type { OperationBundleManifest, OperationDigest } from "./types.js";

/** One bundle's resolved external identities, ready for an approve/drive request. */
export interface ResolvedTarget {
  manifest: OperationBundleManifest;
  manifestDigest: OperationDigest;
  workspaceId: string;
  bundleId: OperationBundleManifest["bundleId"];
  runId: OperationBundleManifest["runId"];
}

/** Scan the whole-root operation inventory (all workspaces). */
export function loadOperationInventory(root: string): Promise<OperationInventory> {
  return scanOperationInventory(root);
}

/**
 * Build a resolved target from a manifest, computing its (self-excluded) digest.
 * The digest is computed rather than read because a manifest never stores its own
 * digest; every run binding recomputes it the same way.
 */
export function resolvedFromManifest(manifest: OperationBundleManifest): ResolvedTarget {
  return {
    manifest,
    manifestDigest: operationManifestDigest(manifest) as OperationDigest,
    workspaceId: manifest.workspaceId,
    bundleId: manifest.bundleId,
    runId: manifest.runId,
  };
}

/**
 * Resolve a caller-supplied target to its manifest identities. The target matches
 * the bundle's operation run id, its bundle id, or its manifest digest; an
 * unknown target returns null.
 *
 * ALL THREE FORMS ARE ACCEPTED BECAUSE ALL THREE ARE PRINTED, and the third is
 * why this rule was widened. `operation list` reports the bundle id and the
 * operation run id, but `product invoke` reports NEITHER — it reports the
 * preparation run id, which is a different identity space, and the bundle
 * MANIFEST DIGEST. Without the digest arm an operator could not paste `invoke`'s
 * own output into `apply`, and the two surfaces would be joined only through a
 * third command. The digest is a durable identity of exactly one bundle (the
 * bundle id is folded into the bytes it digests), so accepting it resolves the
 * same bundle by the same rule rather than by a second one.
 *
 * `resolvedFromManifest` is called on every candidate rather than only on the
 * match: the digest is not stored on the manifest, so comparing against it means
 * recomputing it, and recomputing it through the ONE fold is the point.
 *
 * @param inventory - The scanned operation inventory.
 * @param target - A run id, bundle id, or manifest digest typed by the operator.
 */
export function resolveTarget(inventory: OperationInventory, target: string): ResolvedTarget | null {
  for (const manifest of inventory.manifests) {
    if (manifest.runId === target || manifest.bundleId === target) return resolvedFromManifest(manifest);
    const resolved = resolvedFromManifest(manifest);
    if (resolved.manifestDigest === target) return resolved;
  }
  return null;
}
