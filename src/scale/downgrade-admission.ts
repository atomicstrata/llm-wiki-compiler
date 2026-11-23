/**
 * @file Read-only ordinary admission for an explicit scale-down.
 * A ready record can be visible before the terminal write is durable. Keep
 * ordinary operations out until recovery retires the intent, except while
 * the observed indexed authority still proves the downgrade never fenced.
 */
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { captureDowngradeIntent, type DowngradeIntentV1 } from "../segments/downgrade-access.js";
import { matchesLeafStamp, readStampedLeaf, type LeafStamp } from "../segments/retire-barrier.js";
import { MAX_SCALE_RECORD_BYTES, SCALE_RECORD_FILE, ScaleRefusalError } from "./contracts.js";
import type { ScaleRecord } from "./contracts-v2.js";
import { DOWNGRADE_INTENT_FILE } from "./downgrade-contracts.js";
import { hasScaleRecord, readScaleRecord, type ScaleRecordRead } from "./record.js";
import { parseAnyScaleRecord } from "./record-v2-schema.js";

/** Whether a live intent may exist, using a no-follow presence probe. */
export async function downgradeIntentMayExist(root: string): Promise<boolean> {
  return lstat(path.join(root, DOWNGRADE_INTENT_FILE)).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT" && error.code !== "ENOTDIR");
}

/** Prove a readable, unchanged original or positively identified never-fenced later record. */
async function provesUnfenced(root: string, record: ScaleRecord, intent: DowngradeIntentV1, stamp: LeafStamp): Promise<boolean> {
  if (record.version === 1 || record.active.architecture !== "local-indexed" || record.revision < intent.originalRevision) return false;
  const leaf = await readStampedLeaf(root, SCALE_RECORD_FILE, MAX_SCALE_RECORD_BYTES);
  if (leaf.kind !== "ok") return false;
  const exact = parseAnyScaleRecord(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(leaf.body));
  if (!isDeepStrictEqual(record, exact)) return false;
  let preFence: boolean;
  if (record.revision === intent.originalRevision) {
    preFence = createHash("sha256").update(leaf.body).digest("hex") === intent.originalRecordSha256;
  } else {
    const { provesNeverFencedLater } = await import("./downgrade-admission-stale.js");
    preFence = await provesNeverFencedLater(root, intent, record);
  }
  return preFence && await matchesLeafStamp(root, SCALE_RECORD_FILE, leaf.stamp) && await matchesLeafStamp(root, DOWNGRADE_INTENT_FILE, stamp);
}

/** Whether the current record and its live intent require same-plan recovery. Never writes. */
export async function downgradeNeedsRecovery(root: string, observed?: ScaleRecordRead): Promise<boolean> {
  const read = observed ?? ((await hasScaleRecord(root)) ? await readScaleRecord(root) : { kind: "absent" });
  if (read.kind === "ok" && read.record.pending?.kind === "downgrade") return true;
  if (!(await downgradeIntentMayExist(root))) return false;
  if (read.kind !== "ok") return true;
  try {
    const canonical = await realpath(root);
    const intent = await captureDowngradeIntent(canonical);
    // A changed or unreadable observation is no permission to admit ordinary work.
    return intent.kind !== "ok" || !(await provesUnfenced(canonical, read.record, intent.intent, intent.stamp));
  } catch {
    return true;
  }
}

/** Preserve the typed scale-update refusal for both the fence and an unretired terminal publication. */
export async function assertNoDowngradeForScaleUpdate(root: string, observed?: ScaleRecordRead): Promise<void> {
  if (await downgradeNeedsRecovery(root, observed)) {
    throw new ScaleRefusalError("scale_downgrade_pending", "a scale-down needs recovery; re-run the same scale downgrade --apply or --cancel with its original plan");
  }
}
