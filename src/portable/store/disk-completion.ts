/**
 * @file src/portable/store/disk-completion.ts
 * @description Completing the label bindings of a publication that committed
 * but crashed before they were all written.
 *
 * The commit order is: receipt, then the label binding of each target, then
 * the intent is removed. A crash between the first and the last leaves the
 * intent beside its receipt. That pair is the durable "metadata pending"
 * marker: no new record or format is needed. The receipt is authoritative, so
 * the outcome is committed whatever is found; completion only finishes the
 * label ledger, and never writes, reverts or reclassifies a target's bytes.
 *
 * TWO PHASES. Every pending commit is first VALIDATED — the intent's own
 * fields and every target, the stored receipt (this project's, and exactly the
 * receipt the intent recorded), the targets against that receipt's published
 * objects one for one, and every label record it will touch — and
 * only then is any binding written or any intent removed. Anything that cannot
 * be read with certainty refuses `recovery_blocking`, naming the record to
 * restore, before the first effect.
 *
 * NEVER LOWER. Each target ends bound to the intended labels joined with
 * whatever binding the path already has. A binding of the SAME bytes keeps its
 * digest and gains the intended labels (a stricter same-byte relabel is kept;
 * the same-byte pre/post case with stricter intended labels is closed; a weaker
 * binding a reader reconciled meanwhile is raised). A binding of OTHER bytes
 * that are the path's current bytes — newer work — keeps its digest too and
 * gains the intended labels; otherwise the committed digest is bound. So the
 * path's latest binding, the floor of every later reconciliation, never drops
 * below either the commit or anything bound since.
 */

import type { ContentDigest, LabelSet, ReceiptV1 } from "../contracts.js";
import { bytesDigest, normalizeLabels } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { listFileNames, readJsonRecord, readProjectFile, removeProjectFile, writeProjectFile } from "./disk-io.js";
import { readDiskIntent, type DiskIntentV1, type IntentTarget } from "./disk-intent.js";
import { ledgerDir, ledgerFile, ledgerKey, relativeFileFor } from "./disk-layout.js";
import type { DiskStoreContext } from "./disk-store.js";

/** One label binding as recorded: the digest it binds and its labels. */
interface LabelBinding { digest: ContentDigest; labels: LabelSet }

/** Refusal naming the ledger file an operator must restore. */
function blocked(file: string): PortableRefusal {
  return new PortableRefusal("recovery_blocking", `committed labels cannot be completed: restore ${file}`);
}

/** Bind `labels` to the bytes of `path` with `digest`. */
export async function writeLabelBinding(
  context: DiskStoreContext, path: string, digest: ContentDigest, labels: readonly string[], by: string,
): Promise<void> {
  const record = { path, digest, labels, by };
  await writeProjectFile(context.root, ledgerFile("labels", ledgerKey(path)), JSON.stringify(record));
}

/** The current binding of `path`, or `null` when it was never bound. A damaged one refuses. */
async function currentBinding(context: DiskStoreContext, path: string): Promise<LabelBinding | null> {
  const file = ledgerFile("labels", ledgerKey(path));
  const bytes = await readProjectFile(context.root, file, context.maxRecordBytes).catch(() => { throw blocked(file); });
  if (bytes === null) return null;
  let record: Partial<LabelBinding> | null;
  try {
    record = JSON.parse(bytes.toString("utf8")) as Partial<LabelBinding> | null;
  } catch {
    throw blocked(file);
  }
  const isBinding = typeof record?.digest === "string" && Array.isArray(record.labels) && record.labels.every((label) => typeof label === "string");
  if (!isBinding) throw blocked(file);
  return record as LabelBinding;
}

/** True when `value` is a list of label strings. */
function isLabelSet(value: unknown): value is LabelSet {
  return Array.isArray(value) && value.every((label) => typeof label === "string");
}

/** True when `target` is a complete intent target. */
function isTarget(target: Partial<IntentTarget> | null): boolean {
  return typeof target?.path === "string" && typeof target.postDigest === "string" && target.postDigest.startsWith("sha256:") && isLabelSet(target.labels);
}

/** One binding completion will write: the digest it binds and its labels, or nothing to write. */
interface PlannedBinding { target: IntentTarget; digest: ContentDigest; labels: LabelSet }

/** The binding one committed target needs, never below what the path is already bound to. */
async function planTarget(context: DiskStoreContext, target: IntentTarget): Promise<PlannedBinding | null> {
  const existing = await currentBinding(context, target.path);
  if (existing === null) return { target, digest: target.postDigest, labels: target.labels };
  const labels = normalizeLabels([...existing.labels, ...target.labels]);
  const current = await readProjectFile(context.root, relativeFileFor(target.path), context.maxObjectBytes).catch(() => null);
  const isNewerWork = existing.digest !== target.postDigest && current !== null && bytesDigest(current) === existing.digest;
  const digest = existing.digest === target.postDigest || isNewerWork ? existing.digest : target.postDigest;
  const isUnchanged = digest === existing.digest && JSON.stringify(normalizeLabels(existing.labels)) === JSON.stringify(labels);
  return isUnchanged ? null : { target, digest, labels };
}

/** True when `operationId` has a commit receipt and no recorded close. */
async function isCommittedPending(context: DiskStoreContext, operationId: string): Promise<boolean> {
  const receipt = await readProjectFile(context.root, ledgerFile("receipts", operationId), context.maxRecordBytes);
  if (receipt === null) return false;
  return (await readProjectFile(context.root, ledgerFile("closed", operationId), context.maxRecordBytes)) === null;
}

/** True when `targets` are exactly the receipt's published objects, one for one and in order. */
function matchesPublished(targets: readonly IntentTarget[], published: readonly { path: string; digest: string; labels: readonly string[] }[]): boolean {
  return targets.length === published.length && targets.every((target, index) => target.path === published[index]!.path
    && target.postDigest === published[index]!.digest && JSON.stringify(target.labels) === JSON.stringify(published[index]!.labels));
}

/**
 * The intent of a committed operation, validated against its receipt. A pair
 * carried in whole from another project is not ours and is left as recovery
 * leaves it. Anything else must be exact: a receipt of THIS project whose
 * intent names no or another project, a receipt of another project beside our
 * intent, an intent whose fields or targets are malformed, a stored receipt
 * that is not the one the intent recorded, or targets that are not exactly the
 * receipt's published objects — each refuses.
 */
async function committedIntent(context: DiskStoreContext, operationId: string): Promise<DiskIntentV1 | null> {
  const pair = await readPendingPair(context, operationId);
  if (isForeignPair(context, pair)) return null;
  const mismatched = mismatchedFile(pair, operationId);
  if (mismatched !== null) throw blocked(mismatched);
  return pair.intent;
}

/** One pending commit's two records as read, each with the ledger file it came from. */
interface PendingPair { intent: DiskIntentV1; stored: ReceiptV1; intentFile: string; receiptFile: string }

/**
 * Read the intent, then the receipt. Both files exist (the intent was listed,
 * the receipt checked), so an unreadable, empty or non-object body is damage,
 * never "absent": each refuses, naming its file, the intent's first.
 */
async function readPendingPair(context: DiskStoreContext, operationId: string): Promise<PendingPair> {
  const intentFile = ledgerFile("intents", operationId), receiptFile = ledgerFile("receipts", operationId);
  const intent = await readDiskIntent(context.root, operationId).catch(() => { throw blocked(intentFile); });
  const stored = await readJsonRecord<ReceiptV1>(context.root, receiptFile, context.maxRecordBytes).catch(() => { throw blocked(receiptFile); });
  if (intent === null || typeof intent !== "object") throw blocked(intentFile);
  if (stored === null || typeof stored !== "object") throw blocked(receiptFile);
  return { intent, stored, intentFile, receiptFile };
}

/**
 * True for a pair carried in whole from another project, which is not ours and
 * is left as recovery leaves it. A pair that is only half ours refuses: our
 * receipt beside an intent naming no or another project refuses the intent,
 * and another project's receipt beside our intent refuses the receipt.
 */
function isForeignPair(context: DiskStoreContext, pair: PendingPair): boolean {
  const isOurs = pair.intent.project === context.projectId, isOurReceipt = pair.stored.project === context.projectId;
  if (!isOurs && !isOurReceipt) return true;
  if (!isOurs) throw blocked(pair.intentFile);
  if (!isOurReceipt) throw blocked(pair.receiptFile);
  return false;
}

/**
 * The file to restore when our pair disagrees, checked in this order, or `null`
 * when it is exact: the intent's own fields and targets; the stored receipt
 * being exactly the one the intent recorded; the targets being exactly that
 * receipt's published objects.
 */
function mismatchedFile(pair: PendingPair, operationId: string): string | null {
  const { intent, stored } = pair;
  const targets = intent.targets as readonly Partial<IntentTarget>[] | undefined;
  if (intent.operationId !== operationId || !Array.isArray(targets) || !targets.every(isTarget)) return pair.intentFile;
  if (JSON.stringify(stored) !== JSON.stringify(intent.receipt) || !Array.isArray(stored.published)) return pair.receiptFile;
  return matchesPublished(intent.targets, stored.published) ? null : pair.intentFile;
}

/** Every pending commit, validated, with the bindings it needs. Reads only. */
async function planCompletions(context: DiskStoreContext): Promise<{ operationId: string; bindings: PlannedBinding[] }[]> {
  const plans: { operationId: string; bindings: PlannedBinding[] }[] = [];
  for (const name of await listFileNames(context.root, ledgerDir("intents"))) {
    const operationId = name.replace(/\.json$/u, "");
    if (!(await isCommittedPending(context, operationId))) continue;
    const intent = await committedIntent(context, operationId);
    if (intent === null) continue;
    const bindings: PlannedBinding[] = [];
    for (const target of intent.targets) {
      const planned = await planTarget(context, target);
      if (planned !== null) bindings.push(planned);
    }
    plans.push({ operationId, bindings });
  }
  return plans;
}

/**
 * Finish the label bindings of every committed publication whose intent is
 * still present, then remove that intent. Validates everything before the
 * first write; idempotent, so run again it finds nothing. The caller holds the
 * project gate.
 *
 * @throws PortableRefusal `recovery_blocking`, before any effect, when a needed record cannot be read with certainty.
 */
export async function completeCommittedLabels(context: DiskStoreContext): Promise<void> {
  for (const { operationId, bindings } of await planCompletions(context)) {
    for (const { target, digest, labels } of bindings) await writeLabelBinding(context, target.path, digest, labels, operationId);
    await removeProjectFile(context.root, ledgerFile("intents", operationId));
  }
}
