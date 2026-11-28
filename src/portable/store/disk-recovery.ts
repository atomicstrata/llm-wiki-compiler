/**
 * @file src/portable/store/disk-recovery.ts
 * @description Recovery and resolution of disk publication intents.
 *
 * Recovery looks only at intents with no commit receipt, and it decides from
 * what the targets hold NOW:
 *
 *  - never started            → nothing was written; close as no effect;
 *  - every target at its post → roll forward: write the receipt;
 *  - a mix of pre and post    → revert only the targets still at their post
 *                               image, to the retained pre-state bytes;
 *  - every target at its pre  → no surviving effect (it may have written and
 *                               been undone by someone else; that is not known);
 *  - anything else            → PARK. Revert nothing. An operator resolves it.
 *
 * It never overwrites bytes it does not recognise as its own.
 */

import type { RecoveryDetail, ResolutionRecordV1, TargetObservation } from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import {
  createDurableRecord,
  readProjectFile,
  removeProjectFile,
  writeProjectFile,
} from "./disk-io.js";
import {
  observeTargets,
  observeTargetsWithEvidence,
  preimagesVerify,
  readDiskIntent,
  readRetainedPreimage,
  unresolvedDiskIntents,
  type DiskIntentV1,
} from "./disk-intent.js";
import { ledgerFile, relativeFileFor } from "./disk-layout.js";
import { commitReceipt, writeLabelRecord, writeTail } from "./disk-publish.js";
import type { DiskStoreContext } from "./disk-store.js";
import { IntentTargetsChangedError, type IntentObservation, type RecoveryResult } from "./store.js";

/** Record a terminal, non-committed outcome for an intent, which resolves it. */
async function closeIntent(context: DiskStoreContext, operationId: string, record: unknown): Promise<void> {
  await createDurableRecord(context.root, ledgerFile("closed", operationId), JSON.stringify(record));
  await removeProjectFile(context.root, ledgerFile("intents", operationId));
}

/** Close an intent as a known no-effect outcome. */
async function closeNoEffect(
  context: DiskStoreContext, operationId: string, detail: RecoveryDetail,
): Promise<RecoveryResult> {
  await closeIntent(context, operationId, { operationId, outcome: "refused", detail });
  return { operationId, result: "no-effect", detail };
}

/** Thrown when a revert cannot restore every target; the intent then stays parked. */
class RollbackIncompleteError extends Error {}

/**
 * Restore every target still at its post-image to its retained pre-state:
 * the bytes AND the labels that were bound to them.
 *
 * Every pre-image is verified BEFORE the first target is touched, so a revert
 * either can complete or does not start. If a restore still cannot be done it
 * throws, and the caller must not record the operation as rolled back.
 *
 * The whole target set is observed again here, after the caller decided on
 * `confirmed` (the ordered `{ path, observed }` set it saw). If this
 * observation differs from it in any target's path or class — a target now at
 * neither image, or one that moved between its known pre- and post-image (for
 * example an absent target created externally with exactly its planned bytes)
 * — the set changed in between: it throws {@link IntentTargetsChangedError}
 * before the first write, so no external bytes and none of the operation's
 * other post-images are touched. The comparison reuses this one observation; it
 * adds no read. Pre- and post-image classes each name exact known bytes or
 * absence of this intent, so equal classes mean equal states. A hand edit after
 * THIS observation, between the per-target writes below, is not seen: the
 * revert is a cooperating-writer guarantee, not atomic.
 */
async function revertOwnWrites(
  context: DiskStoreContext, intent: DiskIntentV1, confirmed: readonly TargetObservation[],
): Promise<void> {
  if (!(await preimagesVerify(context.root, intent, context.maxObjectBytes))) throw new RollbackIncompleteError();
  context.faultForTest?.("before-rollback-observation");
  const observations = await observeTargets(context.root, intent, context.maxObjectBytes);
  if (!isConfirmedSet(confirmed, observations)) throw new IntentTargetsChangedError(intent.operationId);
  for (const [index, target] of intent.targets.entries()) {
    if (observations[index].observed !== "post-image") continue;
    const file = relativeFileFor(target.path);
    if (target.pre.state === "absent") {
      await removeProjectFile(context.root, file);
      continue;
    }
    const retained = await readRetainedPreimage(context.root, target, context.maxObjectBytes);
    if (retained === null) throw new RollbackIncompleteError();
    await writeProjectFile(context.root, file, retained);
    await writeLabelRecord(context, target.path, retained, target.pre.labels, `reverted:${intent.operationId}`);
  }
}

/**
 * True when `observed` is exactly the set the caller `confirmed`: same targets,
 * same order, same class, and no target at neither image.
 */
function isConfirmedSet(confirmed: readonly TargetObservation[], observed: readonly TargetObservation[]): boolean {
  if (confirmed.length !== observed.length) return false;
  return observed.every((target, index) => target.observed !== "neither"
    && target.path === confirmed[index].path && target.observed === confirmed[index].observed);
}

/** Decide one intent that has no commit receipt. */
async function recoverOne(context: DiskStoreContext, intent: DiskIntentV1): Promise<RecoveryResult> {
  const { operationId } = intent;
  const started = await readProjectFile(context.root, ledgerFile("started", operationId), context.maxRecordBytes);
  if (started === null) return closeNoEffect(context, operationId, "never_started");
  const decided = await observeTargets(context.root, intent, context.maxObjectBytes);
  const observed = decided.map((t) => t.observed);
  if (observed.every((state) => state === "post-image")) {
    await commitReceipt(context, intent);
    await writeTail(context, operationId, intent.tail.map((item) => ({
      path: item.path, bytes: Buffer.from(item.bytes, "base64"), labels: item.labels,
    })));
    return { operationId, result: "rolled-forward", receipt: intent.receipt };
  }
  if (observed.includes("neither")) return { operationId, result: "parked" };
  if (observed.every((state) => state === "pre-image")) {
    return closeNoEffect(context, operationId, "no_surviving_effect");
  }
  try {
    await revertOwnWrites(context, intent, decided);
  } catch (error) {
    // A pre-image that cannot be restored, or a target set that changed since the decision above: park.
    if (error instanceof RollbackIncompleteError || error instanceof IntentTargetsChangedError) return { operationId, result: "parked" };
    throw error;
  }
  return closeNoEffect(context, operationId, "rolled_back");
}

/** Settle every decidable intent; anything undecidable stays parked. */
export async function recoverDiskIntents(context: DiskStoreContext): Promise<RecoveryResult[]> {
  const results: RecoveryResult[] = [];
  for (const operationId of await unresolvedDiskIntents(context.root)) {
    const intent = await readDiskIntent(context.root, operationId);
    if (intent === null || intent.project !== context.projectId) continue;
    results.push(await recoverOne(context, intent));
  }
  return results;
}

/** Re-observe the targets of a still-unresolved intent. */
export async function observeDiskIntent(
  context: DiskStoreContext, operationId: string,
): Promise<IntentObservation | null> {
  if (!(await unresolvedDiskIntents(context.root)).includes(operationId)) return null;
  const intent = await readDiskIntent(context.root, operationId);
  if (intent === null || intent.project !== context.projectId) return null;
  const { targets, evidence } = await observeTargetsWithEvidence(context.root, intent, context.maxObjectBytes);
  return {
    operationId, targets, evidence,
    preimagesVerify: await preimagesVerify(context.root, intent, context.maxObjectBytes),
  };
}

/** Operator-directed revert of the operation's own surviving writes, if the targets are still the `confirmed` set. */
export async function rollBackDiskIntent(
  context: DiskStoreContext, operationId: string, confirmed: readonly TargetObservation[],
): Promise<void> {
  const intent = await readDiskIntent(context.root, operationId);
  if (intent === null) throw new Error(`no intent for ${operationId}`);
  try {
    await revertOwnWrites(context, intent, confirmed);
  } catch (error) {
    // Nothing is closed: the operation stays parked rather than being called rolled back.
    if (error instanceof RollbackIncompleteError) throw new PortableRefusal("preimage_unavailable");
    // A changed target set (IntentTargetsChangedError) propagates as itself, for the resolver to report.
    throw error;
  }
  await closeIntent(context, operationId, { operationId, outcome: "refused", detail: "rolled_back" });
}

/** Operator-directed close that leaves every target exactly as it is. */
export async function abandonDiskIntent(
  context: DiskStoreContext, operationId: string, resolution: ResolutionRecordV1,
): Promise<void> {
  await closeIntent(context, operationId, { operationId, outcome: "abandoned", resolution });
}
