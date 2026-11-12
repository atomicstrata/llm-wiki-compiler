/**
 * @file One pass's reads of the operation-bundle store.
 *
 * The operation-bundle twin of `preparations/pass-reads.ts`; see it for the
 * pattern. A pass reads the store under one hold of the project lock before it
 * writes. Its steps ask for the key, a manifest, a run; the first asker reads
 * the disk, confined and authenticated as before, and every later asker in the
 * pass shares that answer. Nothing outlives the pass.
 */

import { epochOnly, once, oncePer } from "../utils/pass-memo.js";
import { scannedLeafBytes, type ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import type { BundleId } from "./ids.js";
import { readOperationKey, type OperationKeyRead } from "./key-epoch.js";
import { readOperationManifest, type OperationManifestRead } from "./manifest-store.js";
import { diskOperationRunLeafReads, readOperationRunFrom, type OperationRunRead } from "./run-store.js";
import type { OperationRunBinding } from "./run-types.js";

/** The questions a pass asks of the operation-bundle store. */
export interface OperationPassReads {
  /** The operation key WITH ITS BYTES. */
  readKey(): Promise<OperationKeyRead>;
  /** The key's status and epoch, NEVER the key bytes. */
  readKeyEpoch(): Promise<{ status: "ok"; keyEpochId: OperationRunBinding["keyEpochId"] } | { status: "absent" } | { status: "unavailable" }>;
  /** One manifest by workspace and bundle. */
  readManifest(workspaceId: string, bundleId: BundleId): Promise<OperationManifestRead>;
  /** One run by its binding, authenticated under the pass's one key read. */
  readRun(binding: OperationRunBinding): Promise<OperationRunRead>;
  /**
   * The leaf bytes this pass's inventory walk read, which the reads above and
   * the inventory's authority pass consume once each has proved the leaf still
   * that version. Hand it to the walk (`scanOperationOrphans`); it holds nothing else.
   */
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
