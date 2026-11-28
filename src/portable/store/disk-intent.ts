/**
 * @file src/portable/store/disk-intent.ts
 * @description The disk publication intent: the ONLY recovery record a
 * portable publication has, and the reading of it after a crash.
 *
 * A portable publication opens no legacy journal batch. Before its first write
 * it durably records what it is about to do — each target's pre-image and
 * intended post-image, the retained pre-state bytes, and the receipt it will
 * commit — in a directory legacy replay never scans. Recovery then compares the
 * targets as they are NOW with those images, so it rolls forward or reverts
 * only this operation's own writes and never overwrites newer work.
 *
 * Reading the intents directory classifies EVERY entry: a canonical
 * `<id>.json` record, an exact durable-temp leftover of the create-only writer
 * (never an intent), or anything else, which refuses by name rather than being
 * mistaken for an operation that can never be settled.
 */

import type { ContentDigest, ObjectImage, OperationKind, ReceiptV1, TargetObservation } from "../contracts.js";
import { bytesDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { isSafeRecordId } from "../logical-paths.js";
import { listEntries, readJsonRecord, readProjectFile, type DirectoryEntry } from "./disk-io.js";
import { ledgerDir, ledgerFile, relativeFileFor } from "./disk-layout.js";
import type { TargetEvidence } from "./store.js";

/** One target of a publication, as recorded before any write. */
export interface IntentTarget {
  path: string;
  pre: ObjectImage;
  postDigest: ContentDigest;
  labels: readonly string[];
}

/** The durable intent of one disk publication. */
export interface DiskIntentV1 {
  project: string;
  operationId: string;
  kind: OperationKind;
  targets: readonly IntentTarget[];
  receipt: ReceiptV1;
  /** Derived objects to re-apply on roll-forward; base64 so the record stays JSON. */
  tail: readonly { path: string; bytes: string; labels: readonly string[] }[];
}

/** The name a retained pre-image is stored under: its content digest. */
export function preimageName(digest: ContentDigest): string {
  return digest.slice("sha256:".length);
}

/** Where one target stands relative to the intent's images, from its exact current state. */
function classifyTarget(target: IntentTarget, evidence: TargetEvidence): TargetObservation["observed"] {
  // An unreadable target matches neither image: recovery must park, not guess.
  if (evidence.state === "unverifiable") return "neither";
  const digest = evidence.state === "present" ? evidence.digest : null;
  if (digest === target.postDigest) return "post-image";
  const atPre = target.pre.state === "absent" ? digest === null : digest === target.pre.digest;
  return atPre ? "pre-image" : "neither";
}

/** One target's exact current state, from ONE bounded confined read hashed once. */
async function targetEvidence(root: string, target: IntentTarget, maxBytes: number): Promise<TargetEvidence> {
  const current = await readProjectFile(root, relativeFileFor(target.path), maxBytes).catch(() => undefined);
  if (current === undefined) return { state: "unverifiable" };
  return current === null ? { state: "absent" } : { state: "present", digest: bytesDigest(current) };
}

/**
 * Observe every target of `intent` as it is on disk now: its class, and the
 * exact state behind it (internal evidence, in the same order).
 */
export async function observeTargetsWithEvidence(
  root: string, intent: DiskIntentV1, maxBytes: number,
): Promise<{ targets: TargetObservation[]; evidence: TargetEvidence[] }> {
  const targets: TargetObservation[] = [];
  const evidence: TargetEvidence[] = [];
  for (const target of intent.targets) {
    const seen = await targetEvidence(root, target, maxBytes);
    evidence.push(seen);
    targets.push({ path: target.path, observed: classifyTarget(target, seen) });
  }
  return { targets, evidence };
}

/** Observe every target of `intent` as it is on disk now (its class only, as recovery decides). */
export async function observeTargets(
  root: string, intent: DiskIntentV1, maxBytes: number,
): Promise<TargetObservation[]> {
  return (await observeTargetsWithEvidence(root, intent, maxBytes)).targets;
}

/** The retained pre-state bytes of `target`, or `null` when missing or failing their digest. */
export async function readRetainedPreimage(
  root: string, target: IntentTarget, maxBytes: number,
): Promise<Buffer | null> {
  if (target.pre.state !== "present") return null;
  const file = ledgerFile("preimages", preimageName(target.pre.digest));
  const bytes = await readProjectFile(root, file, maxBytes).catch(() => null);
  return bytes !== null && bytesDigest(bytes) === target.pre.digest ? bytes : null;
}

/** True when every present pre-image of `intent` can actually be restored. */
export async function preimagesVerify(root: string, intent: DiskIntentV1, maxBytes: number): Promise<boolean> {
  for (const target of intent.targets) {
    if (target.pre.state !== "present") continue;
    if ((await readRetainedPreimage(root, target, maxBytes)) === null) return false;
  }
  return true;
}

/** Bound on one ledger record read while scanning for unresolved intents. */
const MAX_LEDGER_RECORD_BYTES = 16 * 1024 * 1024;

/** True when `operationId` has a commit receipt or a recorded close. */
async function isSettled(root: string, operationId: string): Promise<boolean> {
  for (const kind of ["receipts", "closed"] as const) {
    if ((await readProjectFile(root, ledgerFile(kind, operationId), MAX_LEDGER_RECORD_BYTES)) !== null) return true;
  }
  return false;
}

/** The canonical intent record suffix. */
const RECORD_SUFFIX = ".json";

/**
 * The exact siblings the durable create-only writer leaves beside a canonical
 * record when it is interrupted (`atomicWriteNoReplaceDurable`'s deterministic
 * `<record>.tmp` and `<record>.writing`).
 */
const DURABLE_TEMP_SUFFIXES = [`${RECORD_SUFFIX}.tmp`, `${RECORD_SUFFIX}.writing`] as const;

/** One intents-directory entry: a canonical intent record, or a known durable-temp leftover. */
type IntentEntry = { kind: "intent"; operationId: string } | { kind: "durable-temp" };

/** The safe record id `name` names before `suffix`, or `null` when it has no such id. */
function idBefore(name: string, suffix: string): string | null {
  if (!name.endsWith(suffix)) return null;
  const id = name.slice(0, -suffix.length);
  return isSafeRecordId(id) ? id : null;
}

/**
 * Classify one entry of the intents directory. A regular `<safeId>.json` is a
 * canonical intent, decided FIRST, so an id that itself ends in `.json.tmp`
 * (file `<id>.json`) stays a record. A regular exact `<safeId>.json.tmp` or
 * `<safeId>.json.writing` is a durable-temp leftover: the writer finishes the
 * canonical record before any target is written, so a standalone leftover
 * names no publication, and a committed hard-link alias duplicates a record
 * listed under its own name. It is never read, removed or reconciled here.
 *
 * @throws PortableRefusal `recovery_blocking` for anything else — any other
 *   name, an unsafe id, or a directory or link even with a recognised suffix —
 *   naming the entry, so unknown ledger content is never skipped.
 */
function classifyIntentEntry(entry: DirectoryEntry): IntentEntry {
  const operationId = entry.regular ? idBefore(entry.name, RECORD_SUFFIX) : null;
  if (operationId !== null) return { kind: "intent", operationId };
  if (entry.regular && DURABLE_TEMP_SUFFIXES.some((suffix) => idBefore(entry.name, suffix) !== null)) return { kind: "durable-temp" };
  throw new PortableRefusal("recovery_blocking", `intent ledger entry is not a record: ${entry.name}`);
}

/** Entries in plain code-unit order of their names, the order the intent scan has always used. */
function byName(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Ids of intents with neither a commit receipt nor a recorded close.
 * The legacy mutation gate reads this too, without opening a store.
 *
 * Every entry is classified (see {@link classifyIntentEntry}); durable-temp
 * leftovers are not intents, and any unrecognised entry refuses.
 *
 * @throws PortableRefusal `recovery_blocking` naming an entry that is not a record.
 */
export async function unresolvedDiskIntents(root: string): Promise<string[]> {
  const unresolved: string[] = [];
  for (const entry of byName(await listEntries(root, ledgerDir("intents")))) {
    const classified = classifyIntentEntry(entry);
    if (classified.kind === "intent" && !(await isSettled(root, classified.operationId))) unresolved.push(classified.operationId);
  }
  return unresolved;
}

/** The intent of `operationId`, or `null` when none was recorded. */
export function readDiskIntent(root: string, operationId: string): Promise<DiskIntentV1 | null> {
  return readJsonRecord<DiskIntentV1>(root, ledgerFile("intents", operationId), MAX_LEDGER_RECORD_BYTES);
}
