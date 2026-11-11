/**
 * @file One pass's reads of a preparation store.
 *
 * A PASS is a stretch of work that reads the store under one hold of the
 * project lock and reads everything it needs BEFORE it writes: an inventory
 * scan, a settlement pass, a recovery gate. Its steps ask the same questions —
 * the key, a manifest, a run — and each step used to put its question to the
 * disk for itself, so one pass opened the same key file once per run it read.
 *
 * THE PATTERN. Build one of these at the start of a pass and hand it to every
 * step. The first asker of a question reads the disk, confined and
 * authenticated exactly as before; every later asker in the pass gets that same
 * answer. Nothing outlives the pass: a new pass builds a new object and reads
 * the disk again.
 *
 * WHAT IT IS NOT. It is not a cache of the store. It holds no answer across a
 * release of the lock, and a pass must not consult it after writing what it
 * read.
 *
 * TO ADD A READ: add the question to {@link PreparationPassReads} and one
 * `once` or `oncePer` line below (`utils/pass-memo.ts`). A step takes the questions it asks as its
 * collaborator type, as every `…With(steps)` body in this store already does,
 * so a step never learns whether an answer was shared.
 */

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
  /** The preparation key. */
  readKey(): Promise<PreparationKeyRead>;
  /** The key's status and epoch, NEVER the key bytes. */
  readKeyEpoch(): Promise<PreparationKeyEpochRead>;
  /** One manifest by workspace and preparation. */
  readManifest(workspaceId: string, preparationId: PreparationId): Promise<PreparationManifestRead>;
  /** One run by its binding, authenticated under the pass's one key read. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  /**
   * The leaf bytes this pass's inventory walk read, which the manifest and run
   * reads above consume once each has proved the leaf still that version. Hand
   * it to the walk (`scanActivePreparationStore`); it holds nothing else.
   */
  scannedLeaves: ScannedLeafBytes;
  /** The pass's lifecycle reads: a fresh capture per borrow unless the pass was given a shared one. */
  readonly lifecycle: PreparationLifecycleReads;
}

/**
 * The local-disk reads for one pass over the store under `root`. `lifecycle`
 * is a pass-scoped lifecycle read (`preparationLifecycleReadPass`) when the
 * pass's caller shares one capture across its legs and closes it before writing.
 */
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
