/**
 * @file src/portable/store/disk-publish.ts
 * @description The journalled-cooperative publication protocol on disk.
 *
 * Order is the whole point: refuse an operation id that is already settled,
 * retain pre-state bytes, record a durable intent,
 * mark apply-started, write the targets, then write the commit receipt. Once
 * the receipt exists the operation IS committed, whatever happens to its
 * targets later. Before it exists, the intent is enough for recovery to decide
 * what to do without guessing. Anything that cannot retain a pre-image is
 * refused before a single byte changes.
 *
 * Page bytes go through the shared page-apply primitive, so they pass the same
 * confinement, collision re-probe and content floor as a local compile — with
 * a recorder of our own instead of a legacy journal batch.
 */

import { applyPageMutationLocked, type PreStateRecorder } from "../../trust/page-apply.js";
import { COMPILE_ORIGIN } from "../../trust/checks.js";
import type { PagePlannedMutation } from "../../trust/planner.js";
import { bytesDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import {
  createDurableRecord,
  readProjectFile,
  removeProjectFile,
  writeProjectFile,
} from "./disk-io.js";
import { writeLabelBinding } from "./disk-completion.js";
import { preimageName, type DiskIntentV1, type IntentTarget } from "./disk-intent.js";
import { conceptSlugOf, ledgerFile, relativeFileFor } from "./disk-layout.js";
import type { DiskStoreContext } from "./disk-store.js";
import type { PublishBatch, StoredWrite, TailWrite } from "./store.js";

/** Pre-state is already retained in the intent, so the page primitive records nothing more. */
const INTENT_OWNS_PRESTATE: PreStateRecorder = { recordPreState: async () => undefined };

/** Check each target still holds its expected pre-image and retain the bytes to undo it. */
async function retainPreimages(context: DiskStoreContext, writes: readonly StoredWrite[]): Promise<void> {
  let retained = 0;
  for (const write of writes) {
    const current = await readProjectFile(context.root, relativeFileFor(write.path), context.maxObjectBytes);
    const expected = write.pre.state === "absent" ? null : write.pre.digest;
    if ((current === null ? null : bytesDigest(current)) !== expected) {
      throw new PortableRefusal("target_precondition_failed");
    }
    if (current === null) continue;
    retained += current.byteLength;
    if (retained > context.maxPreimageBytes) throw new PortableRefusal("limit_exceeded", "pre-images over cap");
    await retainOne(context, current);
  }
}

/**
 * Retain one pre-image under its content digest. A file already at that name is
 * NOT assumed to be the right bytes: it is read back and hashed, and anything
 * else refuses the operation before a single target changes.
 */
async function retainOne(context: DiskStoreContext, bytes: Buffer): Promise<void> {
  const digest = bytesDigest(bytes);
  const file = ledgerFile("preimages", preimageName(digest));
  if (await createDurableRecord(context.root, file, bytes)) return;
  const existing = await readProjectFile(context.root, file, context.maxObjectBytes).catch(() => null);
  if (existing === null || bytesDigest(existing) !== digest) throw new PortableRefusal("preimage_unavailable");
}

/** The durable intent for `batch`. */
function intentFor(context: DiskStoreContext, batch: PublishBatch): DiskIntentV1 {
  const targets: IntentTarget[] = batch.writes.map((write) => ({
    path: write.path, pre: write.pre, postDigest: bytesDigest(write.bytes), labels: write.labels,
  }));
  const tail = batch.tail.map((item) => ({
    path: item.path, bytes: Buffer.from(item.bytes).toString("base64"), labels: item.labels,
  }));
  return { project: context.projectId, operationId: batch.operationId, kind: batch.kind, targets, receipt: batch.receipt, tail };
}

/** The page mutation for a concept-page write, for the shared page-apply primitive. */
function pageMutation(slug: string, write: StoredWrite): PagePlannedMutation {
  return {
    kind: "page",
    operation: write.pre.state === "absent" ? "create" : "update",
    target: { directory: "concepts", slug },
    body: new TextDecoder("utf-8", { fatal: true }).decode(write.bytes),
    provenance: { origin: COMPILE_ORIGIN, decision: "allow", reviewRouted: false },
  };
}

/** Write one target: a page through the page primitive, anything else through the confined writer. */
async function writeTarget(context: DiskStoreContext, write: StoredWrite): Promise<void> {
  const slug = conceptSlugOf(write.path);
  if (slug !== null) {
    await applyPageMutationLocked(context.root, pageMutation(slug, write), INTENT_OWNS_PRESTATE);
    return;
  }
  await writeProjectFile(context.root, relativeFileFor(write.path), write.bytes);
}

/** Bind labels to the exact bytes just published. */
export async function writeLabelRecord(
  context: DiskStoreContext, path: string, bytes: Uint8Array, labels: readonly string[], by: string,
): Promise<void> {
  await writeLabelBinding(context, path, bytesDigest(bytes), labels, by);
}

/** Best-effort, re-derivable writes made after the receipt. A failure never doubts the commit. */
export async function writeTail(
  context: DiskStoreContext, operationId: string, tail: readonly TailWrite[],
): Promise<void> {
  for (const item of tail) {
    try {
      await writeProjectFile(context.root, relativeFileFor(item.path), item.bytes);
      await writeLabelRecord(context, item.path, item.bytes, item.labels, operationId);
    } catch {
      // Rebuilt by a later publication; never a reason to doubt this one.
    }
  }
}

/**
 * Durably record the commit receipt. A receipt already at that name is this
 * operation's own only when it is byte for byte the one the intent carries (a
 * commit resumed after a crash); any other is a different commit recorded
 * under this id, and vouching for it would bind this operation's writes to
 * someone else's record. That refuses, and the intent stays for an operator.
 */
async function recordReceipt(context: DiskStoreContext, intent: DiskIntentV1): Promise<void> {
  const file = ledgerFile("receipts", intent.operationId);
  const receipt = JSON.stringify(intent.receipt);
  if (await createDurableRecord(context.root, file, receipt)) return;
  const existing = await readProjectFile(context.root, file, context.maxRecordBytes).catch(() => null);
  if (existing === null || existing.toString("utf8") !== receipt) {
    throw new PortableRefusal("recovery_blocking", `a different commit receipt already exists for ${intent.operationId}`);
  }
}

/**
 * Refuse a publication whose operation id is already settled (a commit
 * receipt or a recorded close exists), BEFORE any pre-image, intent or target
 * is written. The authority never submits such an operation (its `begin`
 * answers a known id from the record); this guards the store itself against a
 * ledger that lost the identity but kept the outcome.
 */
async function assertNotSettled(context: DiskStoreContext, operationId: string): Promise<void> {
  for (const kind of ["receipts", "closed"] as const) {
    if ((await readProjectFile(context.root, ledgerFile(kind, operationId), context.maxRecordBytes)) !== null) {
      throw new PortableRefusal("recovery_blocking", `operation ${operationId} is already settled; it cannot be published again`);
    }
  }
}

/**
 * Write the commit receipt and the label bindings it vouches for, then remove
 * the intent. A crash in between leaves the intent beside its receipt, which
 * the next gated step completes (`disk-completion.ts`).
 */
export async function commitReceipt(context: DiskStoreContext, intent: DiskIntentV1): Promise<void> {
  await recordReceipt(context, intent);
  context.faultForTest?.("after-receipt");
  for (const target of intent.targets) {
    const bytes = await readProjectFile(context.root, relativeFileFor(target.path), context.maxObjectBytes);
    if (bytes !== null && bytesDigest(bytes) === target.postDigest) {
      await writeLabelRecord(context, target.path, bytes, target.labels, intent.operationId);
    }
  }
  context.faultForTest?.("after-labels");
  await removeProjectFile(context.root, ledgerFile("intents", intent.operationId));
}

/**
 * Publish one batch by the disk protocol. The caller holds the project gate.
 *
 * @throws PortableRefusal before any write when a precondition or cap fails.
 */
export async function publishToDisk(context: DiskStoreContext, batch: PublishBatch): Promise<void> {
  // Every object this publication would create is bounded, the derived tail included.
  for (const item of [...batch.writes, ...batch.tail]) {
    if (item.bytes.byteLength > context.maxObjectBytes) throw new PortableRefusal("limit_exceeded");
  }
  const intent = intentFor(context, batch);
  const encodedIntent = JSON.stringify(intent);
  // The intent must be readable by the recovery that may need it: refuse here,
  // before any target changes, rather than write a record recovery cannot load.
  if (Buffer.byteLength(encodedIntent, "utf8") > context.maxRecordBytes) throw new PortableRefusal("limit_exceeded");
  await assertNotSettled(context, batch.operationId);
  await retainPreimages(context, batch.writes);
  const recorded = await createDurableRecord(context.root, ledgerFile("intents", batch.operationId), encodedIntent);
  if (!recorded) throw new Error(`an intent already exists for ${batch.operationId}`);
  context.faultForTest?.("after-intent");
  await createDurableRecord(context.root, ledgerFile("started", batch.operationId), "");
  context.faultForTest?.("after-started");
  for (const write of batch.writes) {
    await writeTarget(context, write);
    context.faultForTest?.("after-target");
  }
  context.faultForTest?.("after-writes");
  await commitReceipt(context, intent);
  await writeTail(context, batch.operationId, batch.tail);
}
