/**
 * @file src/operation-bundles/inventory-indexes.ts
 * @description Pure reverse indexes derived from the complete operation
 * inventory. These helpers never read caller claims or mutate durable state.
 */

import path from "node:path";
import type { BundleId } from "./ids.js";
import type { OperationLeafObservation } from "./orphan-scan.js";
import type { BundleGraphNode, OperationBundleManifest } from "./types.js";

/** Build reverse graph indexes from the complete manifest set. */
export function graphNodes(
  manifests: readonly OperationBundleManifest[],
): Map<BundleId, BundleGraphNode> {
  const superseded = new Map<BundleId, BundleId[]>();
  const recovered = new Map<BundleId, BundleId[]>();
  for (const manifest of manifests) {
    if (manifest.supersedesBundleId !== undefined) {
      const values = superseded.get(manifest.supersedesBundleId) ?? [];
      values.push(manifest.bundleId);
      superseded.set(manifest.supersedesBundleId, values);
    }
    if (manifest.recoversBundleId !== undefined) {
      const values = recovered.get(manifest.recoversBundleId) ?? [];
      values.push(manifest.bundleId);
      recovered.set(manifest.recoversBundleId, values);
    }
  }
  return new Map(manifests.map((manifest) => [manifest.bundleId, {
    bundleId: manifest.bundleId, workspaceId: manifest.workspaceId,
    ...(manifest.supersedesBundleId === undefined ? {} : {
      supersedesBundleId: manifest.supersedesBundleId,
    }),
    ...(manifest.recoversBundleId === undefined ? {} : {
      recoversBundleId: manifest.recoversBundleId,
    }),
    supersededByBundleIds: [...(superseded.get(manifest.bundleId) ?? [])].sort(),
    recoveredByBundleIds: [...(recovered.get(manifest.bundleId) ?? [])].sort(),
  }]));
}

/** Index final payload identities by their exact workspace and bundle owner. */
export function payloadDigestsByBundle(
  leaves: readonly OperationLeafObservation[],
): Map<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const leaf of leaves) {
    if (leaf.kind !== "payload" || leaf.protocolAlias !== undefined ||
        leaf.workspaceId === undefined || leaf.bundleId === undefined) continue;
    const key = `${leaf.workspaceId}\0${leaf.bundleId}`;
    const values = result.get(key) ?? new Set<string>();
    values.add(path.basename(leaf.logicalRelativePath));
    result.set(key, values);
  }
  return result;
}
