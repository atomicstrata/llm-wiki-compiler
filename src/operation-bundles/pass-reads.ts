/** The operation-bundle twin of `preparations/pass-reads.ts`; see it for the pattern. */

import { epochOnly, once, oncePer } from "../utils/pass-memo.js";
import { scannedLeafBytes, type ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import type { BundleId } from "./ids.js";
import { readOperationKey, type OperationKeyRead } from "./key-epoch.js";
import { readOperationManifest, type OperationManifestRead } from "./manifest-store.js";
import { diskOperationRunLeafReads, readOperationRunFrom, type OperationRunRead } from "./run-store.js";
import type { OperationRunBinding } from "./run-types.js";

/** The questions a pass asks of the operation-bundle store. */
export interface OperationPassReads {
  readKey(): Promise<OperationKeyRead>;
  readKeyEpoch(): Promise<{ status: "ok"; keyEpochId: OperationRunBinding["keyEpochId"] } | { status: "absent" } | { status: "unavailable" }>;
  readManifest(workspaceId: string, bundleId: BundleId): Promise<OperationManifestRead>;
  readRun(binding: OperationRunBinding): Promise<OperationRunRead>;
  scannedLeaves: ScannedLeafBytes;
}

/** The local-disk reads for one pass over the store under `root`. */
export function operationPassReads(root: string): OperationPassReads {
  const readKey = once(() => readOperationKey(root));
  const scannedLeaves = scannedLeafBytes();
  const runLeaves = { readRunLeaf: diskOperationRunLeafReads(root, scannedLeaves).readRunLeaf, readKey };
  return {
    readKey,
    readKeyEpoch: epochOnly(readKey),
    readManifest: oncePer(
      (workspaceId, bundleId) => `${workspaceId}\0${bundleId}`,
      (workspaceId, bundleId) => readOperationManifest(root, workspaceId, bundleId, scannedLeaves),
    ),
    readRun: oncePer(
      (binding) => [binding.workspaceId, binding.bundleId, binding.runId, binding.manifestDigest, binding.keyEpochId].join("\0"),
      (binding) => readOperationRunFrom(runLeaves, binding),
    ),
    scannedLeaves,
  };
}
