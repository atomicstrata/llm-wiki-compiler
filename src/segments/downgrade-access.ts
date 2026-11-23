/**
 * @file src/segments/downgrade-access.ts
 * @description The BOOTSTRAP INTENT of an explicit scale-down,
 * `.llmwiki/scale-downgrade.json`, and the private scope in which only that
 * scale-down may read the indexed stores it is exporting.
 *
 * INTENT. Written create-only and durably BEFORE the scale record's fence
 * (the `downgrade` pending), it binds the plan digest, the original record
 * (revision and exact bytes' SHA-256), the fence revision, the target and the
 * retained-evidence directory. A crash therefore never leaves a fence without
 * its intent; an intent beside the ORIGINAL record proves only that the fence
 * was not (yet) written, which the scale-down's resume classifies by an exact
 * record read. Ordinary admission also checks the live intent after the
 * fence is replaced. The intent is never rewritten and is retired by an
 * identity-bound rename into its evidence directory, never deleted.
 *
 * SCOPE. While the fence holds, every routed read of the project refuses
 * (`scale-downgrade-pending`) and the scale-down runs as the collector, so
 * its own export reads would refuse too. Only code running inside
 * {@link runWithDowngradeAccess} is admitted, and only while BOTH the intent
 * on disk names the scope's plan AND the live retirement barrier on disk
 * carries the scope's token for that plan, owned by THIS process
 * (`./retire-barrier.ts`), AND the scale record is exactly the intent's fence
 * (a `downgrade` pending with its plan, revision and target). All three are
 * re-checked on every admitted read. It is
 * async-context scoped, never process-wide and never an option; reads it
 * admits register no lease (the project lock and the barrier exclude every
 * collector), and the caller's discipline (plain results only) keeps any
 * snapshot from outliving it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DOWNGRADE_INTENT_FILE as INTENT_PATH } from "../scale/downgrade-contracts.js";
import { publishDowngradeEvidence } from "../scale/downgrade-evidence-write.js";
import { readScaleRecord } from "../scale/record.js";
import { barrierHeldBy, readStampedLeaf, type LeafStamp } from "./retire-barrier.js";

const INTENT_FORMAT = "llmwiki-scale-downgrade-intent";
/** An intent is small; anything larger is not one. */
const MAX_INTENT_BYTES = 4096;
const INTENT_KEYS = "dir,fenceRevision,format,originalRecordSha256,originalRevision,plan,target,version";

/** The durable bootstrap intent of one scale-down. */
export interface DowngradeIntentV1 {
  readonly format: typeof INTENT_FORMAT;
  readonly version: 1;
  readonly plan: string;
  readonly target: "local-standard" | "local-large";
  readonly originalRevision: number;
  readonly originalRecordSha256: string;
  readonly fenceRevision: number;
  /** The project-relative retained-evidence directory of this scale-down. */
  readonly dir: string;
}

/** One read of the intent leaf. */
export type DowngradeIntentRead = { readonly kind: "absent" } | { readonly kind: "unreadable" } | { readonly kind: "ok"; readonly intent: DowngradeIntentV1 };

/** The scale-down whose reads the current async context runs. */
const scope = new AsyncLocalStorage<{ readonly root: string; readonly token: string; readonly plan: string }>();

/** Whether `value` is a lowercase hex digest of 64 digits. */
const isDigest = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
/** Whether `value` is a positive safe integer. */
const isRevision = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Whether `value` is a closed-shape intent this build wrote. */
function isIntent(value: unknown): value is DowngradeIntentV1 {
  return hasIntentShape(value) && intentFieldsValid(value);
}

/** Whether `value` is a closed object with exactly an intent's keys, format and version. */
function hasIntentShape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join() === INTENT_KEYS && record.format === INTENT_FORMAT && record.version === 1;
}

/** Whether an intent's fields are valid and its evidence directory the derived one. */
function intentFieldsValid(record: Record<string, unknown>): boolean {
  const fields = isDigest(record.plan) && isDigest(record.originalRecordSha256) && isRevision(record.originalRevision) && record.fenceRevision === (record.originalRevision as number) + 1;
  const target = record.target === "local-standard" || record.target === "local-large";
  // The evidence directory is exactly the one the scale-down derives from its fence revision and plan.
  return fields && target && record.dir === `.llmwiki/scale-downgrade/${record.fenceRevision as number}-${(record.plan as string).slice(0, 12)}`;
}

/** Read the intent of `root` strictly, binding the parsed value to its file stamp. */
export async function captureDowngradeIntent(root: string): Promise<Exclude<DowngradeIntentRead, { kind: "ok" }> | { kind: "ok"; intent: DowngradeIntentV1; stamp: LeafStamp }> {
  const read = await readStampedLeaf(root, INTENT_PATH, MAX_INTENT_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind !== "ok") return { kind: "unreadable" };
  try {
    const value = JSON.parse(read.body.toString("utf8")) as unknown;
    return isIntent(value) ? { kind: "ok", intent: value, stamp: read.stamp } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Read the intent of `root` without exposing its file stamp. */
export async function readDowngradeIntent(root: string): Promise<DowngradeIntentRead> {
  const read = await captureDowngradeIntent(root);
  return read.kind === "ok" ? { kind: "ok", intent: read.intent } : read;
}

/** Publish or durably checkpoint the exact intent under the project lock. */
export async function createDowngradeIntent(root: string, intent: DowngradeIntentV1, requireExisting = false): Promise<void> {
  if (!isIntent(intent)) throw new Error("the scale-down intent is malformed; nothing was written");
  await publishDowngradeEvidence({ root, relative: INTENT_PATH, maxBytes: MAX_INTENT_BYTES, replayReady: true }, intent, requireExisting);
}

/** Run `body` as the scale-down holding barrier `token` for `plan` on canonical `root`. */
export function runWithDowngradeAccess<T>(root: string, token: string, plan: string, body: () => Promise<T>): Promise<T> {
  return scope.run({ root, token, plan }, body);
}

/** Whether the scale record of `root` is exactly the fence `intent` names. */
async function fenceOf(root: string, intent: DowngradeIntentV1): Promise<boolean> {
  const read = await readScaleRecord(root);
  const pending = read.kind === "ok" ? read.record.pending : null;
  return read.kind === "ok" && pending?.kind === "downgrade" && pending.plan === intent.plan && pending.target === intent.target && read.record.revision === intent.fenceRevision;
}

/**
 * Whether the caller is the scale-down of canonical `root`: in its scope, with
 * the intent naming its plan, the record its exact fence, and the live barrier
 * this process owns carrying its token.
 */
export async function holdsDowngradeAccess(root: string): Promise<boolean> {
  const mine = scope.getStore();
  if (mine?.root !== root) return false;
  const read = await readDowngradeIntent(root);
  if (read.kind !== "ok" || read.intent.plan !== mine.plan || !(await fenceOf(root, read.intent))) return false;
  return barrierHeldBy(root, mine.token, mine.plan);
}
