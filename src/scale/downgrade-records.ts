/**
 * @file src/scale/downgrade-records.ts
 * @description The scale records a scale-down writes, each one revision past
 * the record it replaces, each by compare-and-swap under the project lock:
 *
 * - the FENCE (indexed only): the active `local-indexed` record, unchanged in
 *   layout and capabilities, carrying the new estimate and a `downgrade`
 *   pending naming the target and the plan digest. Written before any
 *   effect; every build refuses dependent work on it.
 * - the ACTIVATION: a version 1 record (the smaller layouts are both
 *   expressible in version 1, so builds that predate `local-indexed` can read
 *   it again) with the target active since this revision, nothing pending
 *   and no capability. Written LAST, after the archive and its receipt.
 *
 * A failed write whose outcome is unknown is classified by an exact read of
 * the record only for legacy writes. A strict write needs successful sync
 * before success or subsequent effects can be reported.
 */

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openConfinedLeaf, readConfirmedBufferOrElse } from "../utils/confined-read.js";
import { assertCurrentParent, fsyncDirectoryChain } from "../utils/atomic-write-durability.js";
import { assertParentNotSymlink } from "../utils/atomic-write-parent.js";
import { MAX_SCALE_RECORD_BYTES, SCALE_RECORD_FILE, ScaleRefusalError } from "./contracts.js";
import type { RequestedScaleV1, ScaleRecordV1 } from "./contracts.js";
import type { DowngradeTarget, ScaleRecord, ScaleRecordV2 } from "./contracts-v2.js";
import { ScaleDowngradeError } from "./downgrade-contracts.js";
import { readScaleRecord, writeScaleRecordFrom, type ScaleRecordIo } from "./record.js";
import { serializeAnyScaleRecord } from "./record-v2-schema.js";

/** The fence record over the active indexed `current`. */
export function fenceRecord(current: ScaleRecordV2, requested: RequestedScaleV1, target: DowngradeTarget, plan: string): ScaleRecordV2 {
  const revision = current.revision + 1;
  return { ...current, revision, requested, pending: { kind: "downgrade", revision, target, plan } };
}

/** The activation record of `target` over `previous`. */
export function activationRecord(previous: ScaleRecord, requested: RequestedScaleV1, target: DowngradeTarget): ScaleRecordV1 {
  const revision = previous.revision + 1;
  return { version: 1, revision, requested, active: { architecture: target, sinceRevision: revision }, pending: null };
}

/** After an uncertain legacy write, accept only an exact visible successor. */
async function classifyLegacyWrite(root: string, next: ScaleRecordV1, error: unknown): Promise<void> {
  const read = await readScaleRecord(root);
  if (read.kind === "ok" && isDeepStrictEqual(read.record, next)) return;
  const found = read.kind === "ok" ? `revision ${read.record.revision}` : read.kind;
  throw new ScaleDowngradeError("scale_downgrade_partial", `the scale record write did not complete (${error instanceof Error ? error.message : String(error)}); the record on disk is ${found}; re-run the same apply`);
}

/**
 * Write `next` over `previous` (compare-and-swap for any version 2 record).
 * Legacy record-only replacement retains visibility-based recovery.
 * Conditional replacement must report failure even if its successor is visible.
 */
export async function writeClassified(root: string, io: ScaleRecordIo, next: ScaleRecord, previous: ScaleRecord): Promise<void> {
  try {
    await writeScaleRecordFrom(io, next, previous);
  } catch (error) {
    if (next.version !== 1 || previous.version !== 1) {
      const reason = error instanceof Error ? error.message : String(error);
      const detail = error instanceof ScaleRefusalError ? { causeCode: error.code } : undefined;
      throw new ScaleDowngradeError("scale_downgrade_partial", `the strict scale record write did not complete (${reason}); retry the same operation`, detail);
    }
    await classifyLegacyWrite(root, next, error);
  }
}

/** Under the project lock, checkpoint an already-proven strict record without replacing it. */
export async function syncPublishedDowngradeRecord(root: string, expected: ScaleRecord): Promise<void> {
  const dir = path.dirname(path.join(root, SCALE_RECORD_FILE));
  try {
    const parent = await assertParentNotSymlink(dir, root, true);
    const before = await readCheckpointLeaf(root, dir);
    if (parent === undefined || before === null || !before.body.equals(Buffer.from(serializeAnyScaleRecord(expected)))) {
      throw new Error("the expected scale record bytes are unavailable");
    }
    await fsyncDirectoryChain(dir, parent);
    const after = await readCheckpointLeaf(root, dir);
    await assertCurrentParent(parent);
    if (!isDeepStrictEqual(after, before)) {
      throw new Error("the scale record changed during the durability checkpoint");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ScaleDowngradeError("scale_downgrade_partial", `the scale record durability checkpoint did not complete (${reason}); retry the same operation`);
  }
}

/** Capture bounded bytes and their stamp from a confined, single-link handle. */
async function readCheckpointLeaf(root: string, dir: string) {
  const leaf = await openConfinedLeaf(root, path.join(root, SCALE_RECORD_FILE), dir, { requireSingleLink: true });
  if (leaf.kind !== "confirmed") return null;
  let stamp;
  try {
    const { dev, ino, size, mtimeNs, ctimeNs } = await leaf.handle.stat({ bigint: true });
    stamp = { dev, ino, size, mtimeNs, ctimeNs };
  } catch (error) {
    await leaf.handle.close().catch(() => {});
    throw error;
  }
  const read = await readConfirmedBufferOrElse(leaf, MAX_SCALE_RECORD_BYTES, () => ({ kind: "unavailable" as const }));
  return read.kind === "ok" ? { body: read.body, stamp } : null;
}
