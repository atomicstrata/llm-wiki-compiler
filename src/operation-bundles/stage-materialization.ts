/**
 * @file src/operation-bundles/stage-materialization.ts
 * @description Exact read-only classification of candidate bundle material.
 * It distinguishes a fully authenticated replay from recoverable payload- or
 * manifest-only durable prefixes before capacity arithmetic or publication.
 */

import {
  MAX_MANIFEST_BYTES, MAX_PAYLOAD_BYTES, MAX_RUN_BYTES,
} from "./constants.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import type { OperationInventory } from "./capacity.js";
import { inspectDurableCandidate } from "./durable-candidate.js";
import { operationPaths } from "./paths.js";
import type { OperationBundleManifest } from "./types.js";

/** Candidate components still requiring one durable publication transition. */
export interface StageMaterialization {
  complete: boolean;
  missingManifest: boolean;
  missingRun: boolean;
  missingPayloads: ReadonlySet<string>;
  physicalActiveByteDelta: number;
  settled: boolean;
}

/** Inspect every intended payload path in deterministic publication order. */
async function inspectPayloads(
  root: string,
  manifest: OperationBundleManifest,
  payloads: ReadonlyMap<string, Buffer>,
): Promise<{ required: Set<string>; byteDelta: number }> {
  const paths = operationPaths(root, manifest.workspaceId);
  const required = new Set<string>();
  let byteDelta = 0;
  for (const [digest, expected] of [...payloads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const inspected = await inspectDurableCandidate(
      root, paths.payloadFile(manifest.bundleId, digest), paths.payloadsRoot(manifest.bundleId),
      expected, MAX_PAYLOAD_BYTES, "operation bundle payload identity conflict",
    );
    if (inspected.publicationRequired) required.add(digest);
    byteDelta += inspected.physicalByteDelta;
  }
  return { required, byteDelta };
}

/** Classify exact existing state and reject every identity collision. */
export async function inspectStageMaterialization(
  root: string,
  manifest: OperationBundleManifest,
  manifestBytes: Buffer,
  payloads: ReadonlyMap<string, Buffer>,
  inventory: OperationInventory,
  runBytes: Buffer | undefined,
): Promise<StageMaterialization> {
  const existing = inventory.manifests.find((item) => item.bundleId === manifest.bundleId);
  if (existing !== undefined && !canonicalBytes(existing).equals(manifestBytes)) {
    throw new Error("operation bundle identity conflict");
  }
  const paths = operationPaths(root, manifest.workspaceId);
  const payloadState = await inspectPayloads(root, manifest, payloads);
  const manifestState = await inspectDurableCandidate(
    root, paths.manifestFile(manifest.bundleId), paths.bundleRoot(manifest.bundleId),
    manifestBytes, MAX_MANIFEST_BYTES, "operation bundle manifest identity conflict", 0o600,
  );
  if (runBytes === undefined) {
    if (inventory.runIds.has(manifest.runId)) throw new Error("operation run identity conflict");
  }
  const runState = runBytes === undefined ? undefined : await inspectDurableCandidate(
    root, paths.runFile(manifest.runId), paths.runsRoot,
    runBytes, MAX_RUN_BYTES, "operation run identity conflict", 0o600,
  );
  if (inventory.runIds.has(manifest.runId) && runState?.authoritative !== true) {
    throw new Error("operation run identity conflict");
  }
  const complete = inventory.completeBundleIds.has(manifest.bundleId);
  const missingRun = runState?.publicationRequired ?? true;
  return {
    complete, missingManifest: manifestState.publicationRequired,
    missingRun, missingPayloads: payloadState.required,
    physicalActiveByteDelta: payloadState.byteDelta + manifestState.physicalByteDelta,
    settled: !manifestState.publicationRequired && !missingRun && payloadState.required.size === 0,
  };
}
