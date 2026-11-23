/**
 * @file src/scale/downgrade-fenced.ts
 * @description The FENCED PHASES of an indexed scale-down (steps A5 to A9),
 * run by the collector inside its private access scope while the fence
 * record holds. Each phase is idempotent and resumes from what the journal
 * and the files show:
 *
 * - FREEZE FIRST: before staging, and so before any file or directory is
 *   moved, the content freeze must still be the plan's. The fence stops this
 *   build's writers but not an editor or another tool, and a resume may come
 *   long after the fence; a change already present refuses here with nothing
 *   moved (the indexed stores in place, no prior file retired).
 * - A5 STAGE: when no attempt is complete, the indexed stores must still be
 *   exactly the plan's (by manifest digest), and a fresh attempt is staged;
 *   a complete attempt must bind exactly the plan's units and prior files.
 * - A6/A7 INSTALL and VERIFY (`./downgrade-install.ts`).
 * - A8 ARCHIVE, verified, then the RECEIPT (`./downgrade-archive.ts`).
 * - A9 ACTIVATION: the content freeze is re-checked (nothing else changed),
 *   then the version 1 record of the target replaces the fence by
 *   compare-and-swap. Nothing is written after it except the cleanup.
 * A test seam announces each durable checkpoint, so a process can be killed
 * at every one of them.
 */

import { INDEXED_DIR } from "../segments/contracts.js";
import type { ScaleRecordV2 } from "./contracts-v2.js";
import { ScaleDowngradeError, type DowngradeSeamFn } from "./downgrade-contracts.js";
import { archiveIndexed, ensureReceipt } from "./downgrade-archive.js";
import { freezeContent } from "./downgrade-freeze.js";
import { identityAt } from "./downgrade-fs.js";
import { indexedFacts } from "./downgrade-indexed-facts.js";
import { installStage, verifyInstalled } from "./downgrade-install.js";
import { checkpointStage, latestStage, type StageManifestV1 } from "./downgrade-journal.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";
import { activationRecord, writeClassified } from "./downgrade-records.js";
import { assertStageMatchesPlan, stageExports } from "./downgrade-stage.js";
import { diskScaleRecordIo } from "./record.js";


/** What the fenced phases need. */
export interface FencedContext {
  readonly root: string;
  readonly plan: DowngradePlanV1;
  readonly dir: string;
  readonly fence: ScaleRecordV2;
  readonly seam?: DowngradeSeamFn;
}

/** Refuse with a partial fault. */
function fault(message: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", message);
}

/** Refuse unless the indexed stores are still exactly the plan's (the fence admits no store write). */
async function assertStoresUnchanged(root: string, plan: DowngradePlanV1): Promise<void> {
  if ((await identityAt(root, INDEXED_DIR)) === null) fault(`${INDEXED_DIR} is gone but no staging attempt is complete`);
  const facts = await indexedFacts(root);
  if (JSON.stringify(facts.stores) !== JSON.stringify(plan.inventory.stores)) {
    throw new ScaleDowngradeError("scale_downgrade_stale_plan", "the indexed stores changed under the fence; inspect the project by hand");
  }
}

/** The complete stage manifest: the latest complete attempt, or a freshly staged one (A5). */
async function stagedManifest(context: FencedContext): Promise<StageManifestV1> {
  const { root, plan, dir } = context;
  const latest = await latestStage(root, dir, plan.digest, plan);
  if (latest.manifest !== null) {
    assertStageMatchesPlan(latest.manifest, plan);
    await checkpointStage(root, dir, latest.manifest);
    return latest.manifest;
  }
  await assertStoresUnchanged(root, plan);
  const manifest = await stageExports(root, plan, dir, latest.nextAttempt);
  await context.seam?.("after-stage");
  return manifest;
}

/** Refuse unless every file outside the installed ones is exactly what the plan froze. */
async function assertFreezeUnchanged(root: string, plan: DowngradePlanV1): Promise<void> {
  const { freeze } = await freezeContent(root, new Set(plan.inventory.priors.map((prior) => prior.relPath)));
  if (freeze.digest !== plan.inventory.freeze.digest) throw new ScaleDowngradeError("scale_downgrade_stale_plan", "files the plan froze changed under the fence; inspect the project by hand");
}

/** Run A5 to A9 over `context`; returns the activation record's revision. */
export async function runFencedPhases(context: FencedContext): Promise<{ revision: number; manifest: StageManifestV1 }> {
  const { root, plan, dir, fence } = context;
  // Refuse a change that is already there before the first move; the same check runs again right before activation.
  await assertFreezeUnchanged(root, plan);
  const manifest = await stagedManifest(context);
  await installStage(root, dir, manifest, context.seam);
  await context.seam?.("after-install");
  await verifyInstalled(root, manifest);
  const leaf = await archiveIndexed(root, dir, plan, context.seam);
  await context.seam?.("after-archive");
  await ensureReceipt(root, dir, plan, fence.revision, leaf, manifest);
  await context.seam?.("after-receipt");
  await assertFreezeUnchanged(root, plan);
  const activated = activationRecord(fence, plan.inventory.requested, plan.inventory.target);
  await writeClassified(root, diskScaleRecordIo(root), activated, fence);
  await context.seam?.("after-activation");
  return { revision: activated.revision, manifest };
}
