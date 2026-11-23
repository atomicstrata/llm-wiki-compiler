/**
 * @file Positive later-record proof used only while a live scale-down intent
 * accompanies a newer indexed record. Reuse the apply stale check and the
 * cancel binding without opening any unbounded record or receipt digest.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { INDEXED_DIR } from "../segments/contracts.js";
import type { DowngradeIntentV1 } from "../segments/downgrade-access.js";
import { matchesLeafStamp, readStampedLeaf } from "../segments/retire-barrier.js";
import type { ScaleRecord } from "./contracts-v2.js";
import { bindCancelIntent } from "./downgrade-cancel-bind.js";
import { staleBeforeFence } from "./downgrade-commit.js";
import { MAX_DOWNGRADE_PLAN_BYTES } from "./downgrade-contracts.js";
import { CANCEL_LEAF, readCancelIntent } from "./downgrade-journal.js";
import { parseDowngradePlan, type DowngradePlanV1 } from "./downgrade-plan.js";

/** Capture the real in-root directory, without accepting a symlink component. */
async function directoryStamp(root: string, relative: string) {
  const dir = path.join(root, relative);
  const stat = await lstat(dir, { bigint: true });
  return stat.isDirectory() && (await realpath(dir)) === dir ? stat : null;
}

/** The B2 shape: only the exact plan and a bound bootstrapped cancel, with no receipt or other evidence. */
async function bootstrappedCancel(root: string, intent: DowngradeIntentV1, plan: DowngradePlanV1): Promise<boolean> {
  const listing = await listConfinedDirBounded(root, intent.dir, 2);
  if (listing.kind !== "ok" || listing.entries.length !== 2) return false;
  const names = listing.entries.filter((entry) => entry.kind === "file").map((entry) => entry.name).sort();
  if (names.join() !== `${CANCEL_LEAF},plan.json`) return false;
  const relative = path.posix.join(intent.dir, CANCEL_LEAF);
  const leaf = await readStampedLeaf(root, relative, MAX_DOWNGRADE_PLAN_BYTES);
  if (leaf.kind !== "ok") return false;
  const cancel = await readCancelIntent(root, intent.dir, intent.plan);
  if (cancel?.phase !== "bootstrapped") return false;
  bindCancelIntent(cancel, plan, intent);
  return matchesLeafStamp(root, relative, leaf.stamp);
}

/** Require the exact plan and original record named by the live intent. */
function matchesPlanIntent(plan: DowngradePlanV1, intent: DowngradeIntentV1): boolean {
  const { record, from, target } = plan.inventory;
  return plan.digest === intent.plan && record.revision === intent.originalRevision
    && record.sha256 === intent.originalRecordSha256 && from === "local-indexed" && target === intent.target;
}

/** Accept only a never-fenced plan or bootstrapped cancel, with its exact retained proof. */
export async function provesNeverFencedLater(root: string, intent: DowngradeIntentV1, record: ScaleRecord): Promise<boolean> {
  const relativePlan = path.posix.join(intent.dir, "plan.json");
  const evidence = await directoryStamp(root, intent.dir);
  const indexed = await directoryStamp(root, INDEXED_DIR);
  if (evidence === null || indexed === null) return false;
  const leaf = await readStampedLeaf(root, relativePlan, MAX_DOWNGRADE_PLAN_BYTES);
  if (leaf.kind !== "ok") return false;
  const bound = parseDowngradePlan(leaf.body.toString("utf8"), root);
  if (!matchesPlanIntent(bound, intent)) return false;
  if (!(await staleBeforeFence(root, bound, intent, record)) && !(await bootstrappedCancel(root, intent, bound))) return false;
  return await matchesLeafStamp(root, relativePlan, leaf.stamp)
    && await matchesLeafStamp(root, intent.dir, evidence)
    && await matchesLeafStamp(root, INDEXED_DIR, indexed);
}
