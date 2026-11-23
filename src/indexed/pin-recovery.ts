/**
 * @file src/indexed/pin-recovery.ts
 * @description EXPLICIT UNPIN of an INTERRUPTED pin publication (IDX-1,
 * slice 3). Only `removePin` (`./pins.ts`) calls this, under the ordinary
 * gated project lock `catalogUnpin` holds, and only when the label holds a
 * reserved publication alias; the alias-free policy stays in `./pins.ts`.
 *
 * WHAT CAN BE OWNED. `createPin` writes each store's copy, then the index,
 * each through the create-only publisher (W = `<target>.writing`, R =
 * `<target>.tmp`, F = `<target>`), serially, so a stop leaves exactly ONE
 * target in W, W+R, R or R+F. The target is either
 *  - the index `pin.json`: its ORIGINAL bytes must be exactly the writer's
 *    serialization (strict UTF-8, closed keys in writer order, a writer-shaped
 *    UTC `createdAt`, strictly increasing distinct bounded entries, final
 *    newline), and the label must hold exactly the copies it names, each a
 *    private single-link manifest of its store matching length and SHA-256; or
 *  - the LAST copy `<store>.manifest`, with no index name at all: its bytes must
 *    be a manifest of that store and EXACTLY the current confined live
 *    manifest, and every other copy a private single-link manifest of an
 *    earlier store in the writer's sorted order.
 * Anything else (two targets, a copy alias beside an index name, a shape the
 * writer never leaves, foreign or malformed bytes) refuses with nothing removed.
 *
 * ORDER. The whole plan is validated read-only first. Then the name set, the
 * label directory, every planned copy stamp and (for a copy target) the live
 * manifest are rechecked; the shared held discard removes the group (W then R,
 * or R then F, syncing around each unlink) only if what it HOLDS is exactly the
 * planned group (state, bytes, the same roles with every full-width leaf stamp,
 * and the held parent's identity); every planned copy is then removed by an
 * identity-bound confined unlink that also requires the planned label
 * directory as its parent, with a sync after each of the very directory handle
 * that is the planned identity, and finally the empty label directory, whose
 * planned identity is checked again by the confined rmdir right before `rmdir`
 * (its absence there is a refusal, not success). A stop reports what it had
 * removed. No alias is ever promoted, relinked or synthesized.
 *
 * BINDING. Settled copies are read through the shared held observer, so their
 * bytes come from the very handle whose stamp is planned, and the path is then
 * required to show that same stamp. A parent binding's numeric identity is
 * compared only when the planned full-width identity is exactly representable;
 * otherwise the proof fails closed. Path-based unlink and rmdir keep their
 * inherent window between the last check and the syscall.
 */

import { lstat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { MAX_SEGMENT_MANIFEST_BYTES } from "../segments/contracts.js";
import { sha256Hex } from "../segments/format.js";
import { readManifestLeaf } from "../segments/io.js";
import { parseManifest } from "../segments/manifest.js";
import type { ParentBinding } from "../utils/atomic-write-durability.js";
import { fsyncConfinedDirectory, rmdirConfinedDurable, unlinkConfinedLeafIfIdentity, type DirIdentity } from "../utils/confined-delete.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { discardProvenPublication, observePublicationGroup, type HeldPublication, type PublicationLeaf, type PublicationState } from "../utils/publication-group.js";
import { COPY_SUFFIX, MAX_PIN_STORES, PIN_INDEX, PINS_DIR, PRIVATE_FILE_MODE, copyStoreOf, isPinHeader, isPinnedStore, pinDir, type PinnedStore } from "./pin-format.js";

/** The create-only writer's reserved siblings of a target (scratch, then ready). */
const ALIAS_SUFFIXES = [".writing", ".tmp"] as const;

/** One settled copy the plan will remove: its name and full-width stamp. */
interface SettledCopy { readonly name: string; readonly stat: BigIntStats }

/** The validated, read-only plan of one interrupted pin. */
interface RecoveryPlan {
  readonly label: string;
  readonly dir: string;
  readonly dirStat: BigIntStats;
  readonly names: readonly string[];
  readonly target: string;
  readonly state: PublicationState;
  readonly group: readonly PublicationLeaf[];
  readonly groupSha: string;
  readonly copies: readonly SettledCopy[];
}

/** The reserved target an alias leaf name belongs to (`pin.json` or `<store>.manifest`), or null. */
export function aliasTargetOf(name: string): string | null {
  for (const suffix of ALIAS_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const target = name.slice(0, -suffix.length);
    return target === PIN_INDEX || copyStoreOf(target) !== null ? target : null;
  }
  return null;
}

/** Whether two stamps are the same file in the same state (link count and ctime included). */
function sameStamp(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Whether a parent binding (numeric identity) is exactly directory stamp `dir`; fails closed when `dir` is not exactly representable. */
function isPlannedParent(parent: ParentBinding, dir: BigIntStats): boolean {
  const exact = dir.dev <= BigInt(Number.MAX_SAFE_INTEGER) && dir.ino <= BigInt(Number.MAX_SAFE_INTEGER);
  return exact && BigInt(parent.dev) === dir.dev && BigInt(parent.ino) === dir.ino;
}

/** The exact identity of directory stamp `dir`. */
const identityOf = (dir: BigIntStats): DirIdentity => ({ dev: dir.dev, ino: dir.ino });

/** A refusal that names the label and says nothing was removed. */
const refusal = (label: string, why: string): Error => new Error(`pin ${label} holds an interrupted publication that cannot be proven (${why}); inspect it by hand, nothing was removed`);

/** Whether `value` is a UTC timestamp exactly as `Date#toISOString` writes it. */
const isWriterTime = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

/** The entries of an interrupted index whose ORIGINAL bytes are exactly the writer's serialization for `label`. */
function canonicalIndex(body: Buffer, label: string): PinnedStore[] {
  let value: Record<string, unknown>;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)) as Record<string, unknown>; } catch { throw refusal(label, "the index is not strict UTF-8 JSON"); }
  if (!isPinHeader(value, label) || !isWriterTime(value.createdAt) || !Array.isArray(value.stores) || value.stores.length > MAX_PIN_STORES) throw refusal(label, "the index is not one this build writes");
  const stores = value.stores as PinnedStore[];
  const ordered = stores.every((entry, at) => isPinnedStore(entry as unknown as Record<string, unknown>) && (at === 0 || stores[at - 1]!.store < entry.store));
  if (!ordered) throw refusal(label, "the index entries are malformed or out of writer order");
  const writer = { format: value.format, version: value.version, label, createdAt: value.createdAt, stores: stores.map(({ store, sha256, bytes }) => ({ store, sha256, bytes })) };
  if (!body.equals(Buffer.from(`${JSON.stringify(writer)}\n`, "utf8"))) throw refusal(label, "the index is not byte for byte what this build writes");
  return stores;
}

/** Where a plan's leaves live: the label, its directory and that directory's planned stamp. */
interface PlanScope { readonly label: string; readonly dir: string; readonly dirStat: BigIntStats }

/** One observed publication group (the held observer's `group` result). */
type HeldGroup = Extract<Awaited<ReturnType<typeof observePublicationGroup>>, { kind: "group" }>;

/** The held settled (F) single-link group at `file` in the planned label directory, or a refusal. */
async function heldSettledCopy(root: string, plan: PlanScope, file: string, name: string): Promise<HeldGroup> {
  const held = await observePublicationGroup(file, root, MAX_SEGMENT_MANIFEST_BYTES);
  if (held.kind !== "group" || held.state !== "F" || !isPlannedParent(held.parent, plan.dirStat)) throw refusal(plan.label, `copy ${name} is not a private single-link file of this label`);
  return held;
}

/** Refuse unless the path still carries the held stamp `stat` with private file mode. */
async function assertCopyUnchanged(plan: PlanScope, file: string, name: string, stat: BigIntStats): Promise<void> {
  const outer = await lstat(file, { bigint: true }).catch(() => null);
  if (outer === null || !sameStamp(outer, stat) || (stat.mode & 0o7777n) !== BigInt(PRIVATE_FILE_MODE)) throw refusal(plan.label, `copy ${name} changed while it was read`);
}

/** Refuse unless `body` matches `entry` (when given) and parses as a manifest of `store`. */
function assertCopyContent(plan: PlanScope, name: string, store: string, body: Buffer, entry?: PinnedStore): void {
  if (entry !== undefined && (body.byteLength !== entry.bytes || sha256Hex(body) !== entry.sha256)) throw refusal(plan.label, `copy ${name} does not match the index`);
  try { parseManifest(body, store); } catch { throw refusal(plan.label, `copy ${name} is not a manifest of ${store}`); }
}

/** The held stamp of settled copy `name` of `store`: a private single-link manifest of that store (matching `entry` when given), read through the held observer. */
async function settledCopy(root: string, plan: PlanScope, name: string, store: string, entry?: PinnedStore): Promise<SettledCopy> {
  const file = path.join(plan.dir, name);
  const held = await heldSettledCopy(root, plan, file, name);
  const stat = held.leaves[0]!.stat;
  await assertCopyUnchanged(plan, file, name, stat);
  assertCopyContent(plan, name, store, held.body, entry);
  return { name, stat };
}

/** The settled copies named by an interrupted index, which must be exactly the label's other leaves. */
async function indexCopies(root: string, plan: PlanScope, body: Buffer, others: readonly string[]): Promise<SettledCopy[]> {
  const entries = canonicalIndex(body, plan.label);
  const expected = entries.map((entry) => `${entry.store}${COPY_SUFFIX}`);
  if (expected.length !== others.length || expected.some((name) => !others.includes(name))) throw refusal(plan.label, "its copies disagree with the interrupted index");
  const copies: SettledCopy[] = [];
  for (const entry of entries) copies.push(await settledCopy(root, plan, `${entry.store}${COPY_SUFFIX}`, entry.store, entry));
  return copies;
}

/** Null when `body` is a manifest of `store` and exactly its current confined live manifest; else the reason. */
async function liveMismatch(root: string, store: string, body: Buffer): Promise<string | null> {
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); parseManifest(body, store); } catch { return `the staged copy is not a manifest of ${store}`; }
  const live = await readManifestLeaf(root, store);
  return live.kind === "ok" && live.bytes.equals(body) ? null : `the staged copy is not the current manifest of ${store}`;
}

/** The earlier settled copies beside an interrupted copy of `store`, after proving the staged bytes against the live manifest. */
async function stagedCopies(root: string, plan: PlanScope, store: string, body: Buffer, others: readonly string[]): Promise<SettledCopy[]> {
  const mismatch = await liveMismatch(root, store, body);
  if (mismatch !== null) throw refusal(plan.label, mismatch);
  const copies: SettledCopy[] = [];
  for (const name of [...others].sort()) {
    const earlier = copyStoreOf(name);
    if (earlier === null || earlier >= store) throw refusal(plan.label, `${name} cannot precede the interrupted copy of ${store}`);
    copies.push(await settledCopy(root, plan, name, earlier));
  }
  return copies;
}

/** The single interrupted target among `names`, and the label's other leaves; refuses two targets or a copy alias beside an index name. */
function targetOf(label: string, names: readonly string[]): { target: string; others: string[] } {
  const targets = new Set(names.map(aliasTargetOf).filter((target) => target !== null));
  if (targets.size !== 1) throw refusal(label, `${targets.size} interrupted targets; the writer leaves at most one`);
  const target = [...targets][0]!;
  const others = names.filter((name) => name !== target && aliasTargetOf(name) !== target);
  if (others.some((name) => copyStoreOf(name) === null)) throw refusal(label, "an index name beside an interrupted copy");
  if (others.length + (target === PIN_INDEX ? 0 : 1) > MAX_PIN_STORES) throw refusal(label, `more than ${MAX_PIN_STORES} copies`);
  return { target, others };
}

/** Validate the whole interrupted pin `label` read-only: the exact plan, or a refusal. */
async function planRecovery(root: string, label: string, names: readonly string[]): Promise<RecoveryPlan> {
  const dir = path.join(root, pinDir(label));
  const { target, others } = targetOf(label, names);
  const dirStat = await lstat(dir, { bigint: true });
  const observed = await observePublicationGroup(path.join(dir, target), root, MAX_SEGMENT_MANIFEST_BYTES);
  if (observed.kind !== "group" || observed.state === "F") throw refusal(label, observed.kind === "refused" ? observed.reason : `${target} is no interrupted state`);
  if (!isPlannedParent(observed.parent, dirStat)) throw refusal(label, "the interrupted publication is not in the label directory");
  const scope = { label, dir, dirStat };
  const store = copyStoreOf(target);
  const copies = store === null ? await indexCopies(root, scope, observed.body, others) : await stagedCopies(root, scope, store, observed.body, others);
  return { label, dir, dirStat, names: [...names].sort(), target, state: observed.state, group: observed.leaves, groupSha: sha256Hex(observed.body), copies };
}

/**
 * Refuse unless the label still holds exactly the planned names, directory and copy stamps, and the
 * target's fresh observation IS the planned group (state, bytes, roles, full-width stamps, parent);
 * only then, for a copy target, is that observed body compared with the live manifest.
 */
async function assertPlanCurrent(root: string, plan: RecoveryPlan): Promise<void> {
  await assertLabelUnchanged(root, plan);
  await assertCopiesUnchanged(plan);
  await assertTargetHeld(root, plan);
}

/** Refuse unless the label lists exactly the planned names and its directory keeps the planned identity. */
async function assertLabelUnchanged(root: string, plan: RecoveryPlan): Promise<void> {
  const listing = await listConfinedDirBounded(root, pinDir(plan.label), MAX_PIN_STORES + 2);
  const names = listing.kind === "ok" ? listing.entries.map((entry) => entry.name).sort() : [];
  const dir = await lstat(plan.dir, { bigint: true });
  if (names.join("\n") !== plan.names.join("\n") || dir.dev !== plan.dirStat.dev || dir.ino !== plan.dirStat.ino) throw refusal(plan.label, "the label changed during the unpin");
}

/** Refuse unless every planned copy keeps its planned stamp (checked one at a time, in plan order). */
async function assertCopiesUnchanged(plan: RecoveryPlan): Promise<void> {
  for (const copy of plan.copies) if (!sameStamp(await lstat(path.join(plan.dir, copy.name), { bigint: true }), copy.stat)) throw refusal(plan.label, `copy ${copy.name} changed during the unpin`);
}

/** Refuse unless the target's fresh observation is the planned group and, for a copy target, its body is still the live manifest. */
async function assertTargetHeld(root: string, plan: RecoveryPlan): Promise<void> {
  const store = copyStoreOf(plan.target);
  const group = await observePublicationGroup(path.join(plan.dir, plan.target), root, MAX_SEGMENT_MANIFEST_BYTES);
  if (group.kind !== "group" || !heldIsPlanned(plan, group.state, group.body, group)) throw refusal(plan.label, "the interrupted publication changed during the unpin");
  if (store !== null && (await liveMismatch(root, store, group.body)) !== null) throw refusal(plan.label, "the staged copy no longer matches the live manifest");
}

/** Whether what the discard HOLDS is exactly the planned group: state, bytes, the same roles with every full-width stamp, and the planned parent. */
function heldIsPlanned(plan: RecoveryPlan, state: PublicationState, body: Buffer, held: HeldPublication): boolean {
  if (state !== plan.state || sha256Hex(body) !== plan.groupSha || held.leaves.length !== plan.group.length) return false;
  const sameLeaves = plan.group.every((leaf, at) => held.leaves[at]!.name === leaf.name && sameStamp(held.leaves[at]!.stat, leaf.stat));
  return sameLeaves && isPlannedParent(held.parent, plan.dirStat);
}

/** Remove every planned copy by identity, syncing after each, then the empty label directory; a stop names what was removed. */
async function removeCopies(root: string, plan: RecoveryPlan): Promise<void> {
  const removed: string[] = [plan.target];
  try {
    for (const copy of plan.copies) {
      const outcome = await unlinkConfinedLeafIfIdentity(root, path.join(plan.dir, copy.name), plan.dir, (stat) => sameStamp(stat, copy.stat), identityOf(plan.dirStat));
      if (outcome !== "unlinked") throw new Error(`copy ${copy.name} changed before its removal`);
      removed.push(copy.name);
      await fsyncConfinedDirectory(root, plan.dir, identityOf(plan.dirStat)); // syncs only the planned directory
    }
    await rmdirConfinedDurable(root, plan.dir, path.join(root, PINS_DIR), identityOf(plan.dirStat));
  } catch (error) {
    throw new Error(`pin ${plan.label}: ${error instanceof Error ? error.message : String(error)}; removed before stopping: the interrupted publication and ${removed.length - 1} copies`);
  }
}

/** Explicitly unpin interrupted pin `label` whose leaf names are `names` (all regular files). The caller holds the gated project lock. */
export async function removeInterruptedPin(root: string, label: string, names: readonly string[]): Promise<void> {
  const plan = await planRecovery(root, label, names);
  await assertPlanCurrent(root, plan);
  await discardProvenPublication(path.join(plan.dir, plan.target), root, MAX_SEGMENT_MANIFEST_BYTES, (state, body, held) => heldIsPlanned(plan, state, body, held));
  await removeCopies(root, plan);
}
