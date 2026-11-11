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

import { readPreparationKey, type PreparationKeyEpochRead, type PreparationKeyRead } from "./key-epoch.js";
import { readPreparationManifest, type PreparationManifestRead } from "./manifest-store.js";
import type { PreparationId } from "./ids.js";
import { diskPreparationRunLeafReads, readPreparationRunFrom, type PreparationRunRead } from "./run-store.js";
import type { PreparationRunBinding } from "./run-types.js";
import { epochOnly, once, oncePer } from "../utils/pass-memo.js";

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
}

/** The local-disk reads for one pass over the store under `root`. */
export function preparationPassReads(root: string): PreparationPassReads {
  const readKey = once(() => readPreparationKey(root));
  const runLeaves = { readRunLeaf: diskPreparationRunLeafReads(root).readRunLeaf, readKey };
  return {
    readKey,
    readKeyEpoch: epochOnly(readKey),
    readManifest: oncePer(
      (workspaceId, preparationId) => `${workspaceId}\0${preparationId}`,
      (workspaceId, preparationId) => readPreparationManifest(root, workspaceId, preparationId),
    ),
    readRun: oncePer(
      (binding) => [binding.workspaceId, binding.preparationId, binding.runId, binding.manifestDigest, binding.keyEpochId].join("\0"),
      (binding) => readPreparationRunFrom(runLeaves, binding),
    ),
  };
}
