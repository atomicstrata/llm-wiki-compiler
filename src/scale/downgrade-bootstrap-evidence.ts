/**
 * @file Same-plan entry for an interrupted bootstrap publication.
 * A strict intent reader never admits a two-link leaf. Recover it under the
 * raw project lock only while the original record and existing plan agree.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { createDowngradeIntent, type DowngradeIntentV1 } from "../segments/downgrade-access.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { MAX_SCALE_RECORD_BYTES, SCALE_RECORD_FILE } from "./contracts.js";
import { isOwnOriginal } from "./downgrade-cancel-bind.js";
import { assertNotCancelled, assertPlanLeaf } from "./downgrade-cancel-evidence.js";
import { DOWNGRADE_INTENT_FILE, ScaleDowngradeError } from "./downgrade-contracts.js";
import { at } from "./downgrade-fs.js";
import { mayHaveEvidenceAlias } from "./downgrade-evidence-write.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";
import { readScaleRecord } from "./record.js";

/** Recover only an exact, already-visible bootstrap before the first fence. */
export async function repairBootstrapIntent(root: string, plan: DowngradePlanV1, intent: DowngradeIntentV1): Promise<void> {
  if (!(await mayHaveEvidenceAlias(root, DOWNGRADE_INTENT_FILE))) return;
  await acquireLockBlocking(root);
  try {
    if (!(await mayHaveEvidenceAlias(root, DOWNGRADE_INTENT_FILE))) return;
    await assertNotCancelled(root, intent.dir);
    const current = await readScaleRecord(root);
    const file = at(root, SCALE_RECORD_FILE);
    const bytes = await readConfinedLeafBuffer(root, file, path.dirname(file), MAX_SCALE_RECORD_BYTES, { requireSingleLink: true });
    if (current.kind !== "ok" || !isOwnOriginal(current.record, intent)
        || bytes.kind !== "ok" || createHash("sha256").update(bytes.body).digest("hex") !== intent.originalRecordSha256) {
      throw new ScaleDowngradeError("scale_downgrade_partial", "the original record no longer proves an interrupted downgrade bootstrap");
    }
    await assertPlanLeaf(root, intent.dir, plan);
    await createDowngradeIntent(root, intent, true);
  } finally {
    await releaseLock(root);
  }
}
