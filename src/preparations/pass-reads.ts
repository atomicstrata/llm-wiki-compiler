/** A PASS is a stretch of work that reads the store under one hold of the project lock and reads everything it needs BEFORE it writes: an inventory scan, a settlement pass, a recovery gate. */

import type { PreparationKeyEpochRead, PreparationKeyRead } from "./key-epoch.js";
import { readPreparationManifest, type PreparationManifestRead } from "./manifest-store.js";
import type { PreparationId } from "./ids.js";
import { preparationRunHoldReads, type PreparationRunRead } from "./run-store.js";
import type { PreparationRunBinding } from "./run-types.js";
import { epochOnly, oncePer } from "../utils/pass-memo.js";
import { scannedLeafBytes, type ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import { perBorrowLifecycleReads, type PreparationLifecycleReads } from "./lifecycle-snapshot/read.js";

/** The questions a pass asks of one preparation store. */
export interface PreparationPassReads {
  readKey(): Promise<PreparationKeyRead>;
  readKeyEpoch(): Promise<PreparationKeyEpochRead>;
  readManifest(workspaceId: string, preparationId: PreparationId): Promise<PreparationManifestRead>;
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  scannedLeaves: ScannedLeafBytes;
  readonly lifecycle: PreparationLifecycleReads;
}

/** The local-disk reads for one pass over the store under `root`. */
export function preparationPassReads(
  root: string, lifecycle: PreparationLifecycleReads = perBorrowLifecycleReads(root),
): PreparationPassReads {
  const scannedLeaves = scannedLeafBytes();
  const { readKey, readRun } = preparationRunHoldReads(root, scannedLeaves);
  return {
    lifecycle,
    readKey,
    readKeyEpoch: epochOnly(readKey),
    readManifest: oncePer(
      (workspaceId, preparationId) => `${workspaceId}\0${preparationId}`,
      (workspaceId, preparationId) => readPreparationManifest(root, workspaceId, preparationId, scannedLeaves),
    ),
    readRun,
    scannedLeaves,
  };
}
