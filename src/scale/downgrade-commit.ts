/**
 * @file src/scale/downgrade-commit.ts
 * @description How a resumed scale-down RECOGNIZES that its activation
 * already committed, and how it retires its own intent, without ever
 * touching what the project did afterwards.
 *
 * COMMITTED. Only this scale-down's activation can replace its fence: older
 * builds cannot read the fence, and this build refuses every other record
 * change while it holds. At every revision the proof needs this scale-down's
 * receipt AND its archived indexed directory still being exactly the object
 * the receipt names (a missing or replaced archive is not proof). Then:
 * - at EXACTLY the activation revision, the record must be byte-for-byte the
 *   expected activation record (version 1, the target active since then);
 * - at a STRICTLY higher revision (an ordinary later `scale set`, even one
 *   that prepared `local-indexed` again), the record itself is not inspected
 *   further. The current record, any new `.llmwiki/indexed` and any newer
 *   pending work are never touched.
 * Anything else (a lower revision, an unreadable record, a missing receipt or
 * archive) is not proof, and the resume refuses.
 *
 * STALE BEFORE ITS FENCE. When admission proves the scale-down is still
 * before its fence, an ordinary `scale set` may
 * write newer records. Such an intent is recognized, read-only, only when it
 * PROVABLY never fenced: a readable NEWER version 2/3 record with
 * `local-indexed` active and no `downgrade` pending, the indexed directory
 * still in place, and the intent's exact derived evidence directory holding
 * nothing but its own single-link `plan.json` (bound to the intent and the
 * applied plan). Once a fence exists, this build refuses every record change
 * but the activation and older builds cannot read it, and staging creates its
 * attempt directory right after the fence, so any attempt, prior file,
 * archive, receipt or unknown entry means the fence may have been written:
 * that is never stale, and the resume refuses with everything kept. A stale
 * intent is classified as bootstrapped; the apply's locked re-check then finds
 * the plan stale and retires it through the ordinary path.
 *
 * INTENT RETIREMENT. The intent is moved into its evidence directory only
 * while the leaf is still EXACTLY this scale-down's intent (content and the
 * identity it was read from); a different intent, even for the same plan, is
 * never moved.
 *
 * RETIREMENT REPLAY. The rename can succeed and a parent checkpoint then fail.
 * A retry recognizes that state only as the exact retired intent of this plan
 * (`<dir>/intent.json`, confined, single-link, equal to the intent derived
 * from the plan) with the live marker absent, and only after its caller has
 * proved the terminal outcome under the raw lock (a committed record and
 * receipt, or a bound cancel receipt). It then syncs both parents again in the
 * original order (the live intent's parent, then the evidence directory) and
 * never recreates the live intent. A stale pre-fence retirement has no
 * receipt, so it is never taken for a finished one.
 */

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { INDEXED_DIR } from "../segments/contracts.js";
import { createDowngradeIntent, readDowngradeIntent, type DowngradeIntentV1 } from "../segments/downgrade-access.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import type { ScaleRecord } from "./contracts-v2.js";
import { archivedIndexed } from "./downgrade-archive.js";
import { DOWNGRADE_INTENT_FILE, MAX_DOWNGRADE_PLAN_BYTES, ScaleDowngradeError } from "./downgrade-contracts.js";
import { at, finishMove, identityAt, renameBound, sameObject } from "./downgrade-fs.js";
import { checkpointReceipt, downgradeDir, readReceipt } from "./downgrade-journal.js";
import { parseDowngradePlan, type DowngradePlanV1 } from "./downgrade-plan.js";
import { activationRecord } from "./downgrade-records.js";

/** The only leaf a never-fenced scale-down has in its evidence directory. */
const PLAN_LEAF = "plan.json";
/** The retired intent's leaf in its evidence directory. */
const RETIRED_INTENT_LEAF = "intent.json";

/** Whether `record` proves the activation of `plan`, fenced as `intent`, committed. */
export async function committedAt(root: string, plan: DowngradePlanV1, intent: DowngradeIntentV1, record: ScaleRecord | null, sync = false): Promise<boolean> {
  if (record === null || record.revision <= intent.fenceRevision) return false;
  const receipt = await readReceipt(root, intent.dir, intent.plan);
  if (receipt === null || receipt.fenceRevision !== intent.fenceRevision) return false;
  // The receipted archive is part of the proof at every revision: without it a replay could succeed and clean its barrier.
  const archived = await identityAt(root, archivedIndexed(intent.dir));
  if (archived === null || !sameObject(archived, receipt.archive.indexed as Parameters<typeof sameObject>[0])) return false;
  if (record.revision === intent.fenceRevision + 1) {
    const expected = activationRecord({ revision: intent.fenceRevision } as ScaleRecord, plan.inventory.requested, plan.inventory.target);
    if (!isDeepStrictEqual(record, expected)) return false;
  }
  if (sync) await checkpointReceipt(root, intent.dir, receipt);
  return true;
}

/** Whether the evidence directory of `intent` holds exactly its own single-link `plan.json`, the plan `plan` (any other entry, kind or doubt: false). */
async function onlyOwnPlan(root: string, plan: DowngradePlanV1, intent: DowngradeIntentV1): Promise<boolean> {
  const listing = await listConfinedDirBounded(root, intent.dir, 1);
  if (listing.kind !== "ok" || listing.entries.length !== 1 || listing.entries[0]!.name !== PLAN_LEAF || listing.entries[0]!.kind !== "file") return false;
  const leaf = at(root, path.posix.join(intent.dir, PLAN_LEAF));
  const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), MAX_DOWNGRADE_PLAN_BYTES, { requireSingleLink: true });
  if (read.kind !== "ok") return false;
  try {
    return parseDowngradePlan(read.body.toString("utf8"), root).digest === intent.plan && intent.plan === plan.digest;
  } catch (error) {
    if (error instanceof ScaleDowngradeError) return false;
    throw error;
  }
}

/** Whether `intent` of `plan` provably never wrote its fence while `record` moved past its original (see the file comment). Read-only. */
export async function staleBeforeFence(root: string, plan: DowngradePlanV1, intent: DowngradeIntentV1, record: ScaleRecord | null): Promise<boolean> {
  if (record === null || record.version === 1 || record.revision <= intent.originalRevision) return false;
  if (record.active.architecture !== "local-indexed" || record.pending?.kind === "downgrade") return false;
  if (intent.dir !== downgradeDir(plan, intent.fenceRevision) || (await identityAt(root, INDEXED_DIR))?.kind !== "directory") return false;
  return onlyOwnPlan(root, plan, intent);
}

/** Retire `intent` into its evidence directory, only while the leaf is exactly it. */
export async function retireOwnIntent(root: string, intent: DowngradeIntentV1): Promise<void> {
  const before = await identityAt(root, DOWNGRADE_INTENT_FILE);
  if (before === null) return;
  const read = await readDowngradeIntent(root);
  const after = await identityAt(root, DOWNGRADE_INTENT_FILE);
  if (read.kind !== "ok" || !isDeepStrictEqual(read.intent, intent) || after === null || !sameObject(before, after)) {
    throw new ScaleDowngradeError("scale_downgrade_partial", `${DOWNGRADE_INTENT_FILE} is not this scale-down's intent; it was not moved`);
  }
  await createDowngradeIntent(root, intent, true);
  await renameBound(root, DOWNGRADE_INTENT_FILE, retiredIntentPath(intent), before);
}

/** Where `intent` is retired: its own evidence directory. */
function retiredIntentPath(intent: DowngradeIntentV1): string {
  return path.posix.join(intent.dir, RETIRED_INTENT_LEAF);
}

/** Whether `<dir>/intent.json` is exactly `intent` (a confined single-link leaf). Read-only. */
export async function isRetiredIntent(root: string, intent: DowngradeIntentV1): Promise<boolean> {
  const leaf = at(root, retiredIntentPath(intent));
  const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), MAX_DOWNGRADE_PLAN_BYTES, { requireSingleLink: true });
  if (read.kind !== "ok") return false;
  try { return isDeepStrictEqual(JSON.parse(read.body.toString("utf8")), intent); } catch { return false; }
}

/**
 * Sync both parents of an already-renamed retirement again (see RETIREMENT
 * REPLAY). The caller holds the raw lock and has proved the terminal outcome;
 * this rechecks that the live marker is absent and the retired leaf is exactly
 * `intent`, and lets any sync failure propagate.
 */
export async function finishRetirement(root: string, intent: DowngradeIntentV1): Promise<void> {
  if ((await identityAt(root, DOWNGRADE_INTENT_FILE)) !== null || !(await isRetiredIntent(root, intent))) {
    throw new ScaleDowngradeError("scale_downgrade_partial", `${intent.dir}/${RETIRED_INTENT_LEAF} is not this scale-down's retired intent; nothing was synced`);
  }
  await finishMove(root, DOWNGRADE_INTENT_FILE, retiredIntentPath(intent));
}
