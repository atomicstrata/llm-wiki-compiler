/**
 * @file src/utils/publication-group.ts
 * @description A CONSUMER-OWNED view of one create-only publication, and the
 * identity-bound discard of an abandoned one. Never a promotion.
 *
 * The buffered create-only writer (`./atomic-write.ts`) takes one target F
 * through W (`<F>.writing`) -> W+R (`<F>.tmp`, a second link) -> R -> R+F ->
 * F. {@link observePublicationGroup} looks only at those three code-derived
 * names under the exact, bound, existing parent: no wildcard, no recursion,
 * and the leaves are never used as paths. It admits only the five serial
 * states (W, W+R, R, R+F, F); every leaf must be a regular, non-symlink file
 * with private mode 0600 and no special bits, a nonzero inode, one link when
 * alone, or exactly two links on the SAME device and inode as a pair. Only
 * ENOENT means absent. The bytes are read through ONE capped, no-follow,
 * nonblocking held handle, whose stamp (size, mode, device, inode, link
 * count, mtime, ctime) must equal every path's before and after the read.
 * Preview callers get facts only: the handle is closed.
 *
 * {@link discardProvenPublication} re-observes under the caller's lock,
 * holds that fresh handle (so the inode cannot be freed and reused) while the
 * caller's `prove` checks the exact bytes, then unlinks in the writer's own
 * order (W before R, R before F) so every intermediate state stays
 * recognizable. The parent is synced before each unlink and after it; the
 * parent binding and every remaining leaf's stamp are rechecked immediately
 * before each unlink. A paired alias goes through the narrow
 * `removeCommittedTemp` step; a single-link survivor through the unchanged
 * single-link `unlinkConfinedLeafIfIdentity`. Any validation or sync failure
 * stops at once and reports exactly what was removed. A settled F alone is
 * left to its consumer. Same-UID races outside cooperating writers remain
 * within the repository's portable last-check limit.
 */

import { constants, type BigIntStats } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertCurrentParent, fsyncDirectoryChain, type ParentBinding } from "./atomic-write-durability.js";
import { durableTempPath, durableWritingPath, removeCommittedTemp } from "./atomic-write-no-replace-durable.js";
import { assertParentNotSymlink } from "./atomic-write-parent.js";
import { unlinkConfinedLeafIfIdentity } from "./confined-delete.js";
import { openFileNoFollow } from "./no-follow-open.js";

/** The one private mode every leaf of a recognized publication has. */
const PRIVATE_MODE = 0o600;
/** The reserved names of one publication. */
export type PublicationName = "W" | "R" | "F";
/** The serial states the writer can leave, by the sorted names present. */
export type PublicationState = "W" | "WR" | "R" | "RF" | "F";
const STATES: Readonly<Record<string, PublicationState>> = { W: "W", "R,W": "WR", R: "R", "F,R": "RF", F: "F" };
/** The writer's unlink order for each abandoned state. */
const DISCARD_ORDER: Readonly<Record<Exclude<PublicationState, "F">, readonly PublicationName[]>> = { W: ["W"], WR: ["W", "R"], R: ["R"], RF: ["R", "F"] };

/** One present leaf: its name, path and full-width stamp. */
export interface PublicationLeaf { readonly name: PublicationName; readonly path: string; stat: BigIntStats }

/** What one observation found. */
export type PublicationObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "group"; readonly state: PublicationState; readonly leaves: PublicationLeaf[]; readonly body: Buffer; readonly parent: ParentBinding };

/** What a discard holds when it asks for proof: its leaves (full-width stamps) and its bound parent. */
export interface HeldPublication { readonly leaves: readonly PublicationLeaf[]; readonly parent: ParentBinding }

/** A discard that stopped: why, and exactly which names it had already removed. */
class PublicationDiscardError extends Error {
  constructor(message: string, readonly removed: readonly PublicationName[]) {
    super(`${message}; removed before stopping: ${removed.length === 0 ? "nothing" : removed.join(", ")}`);
    this.name = "PublicationDiscardError";
  }
}

/** The three reserved paths of target `finalPath`. */
function namesOf(finalPath: string): Record<PublicationName, string> {
  return { W: durableWritingPath(finalPath), R: durableTempPath(finalPath), F: finalPath };
}

/** Whether two stamps are the same file in the same state (link count included). */
function sameStamp(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** The leaf at `file`, null when ENOENT; any other fault throws. */
async function leafAt(file: string): Promise<BigIntStats | null> {
  try { return await lstat(file, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Why one leaf is not a private regular file with an inode, or null (checks in this fixed order). */
function leafProblem({ name, stat }: PublicationLeaf): string | null {
  if (!stat.isFile() || stat.isSymbolicLink()) return `${name} is not a regular file`;
  if ((stat.mode & 0o7777n) !== BigInt(PRIVATE_MODE)) return `${name} does not have private mode 0600`;
  if (stat.ino === 0n) return `${name} has no inode`;
  return null;
}

/** Whether two leaves are exactly one inode with two links (same device and inode). */
function isOneTwoLinkInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.nlink === 2n && b.nlink === 2n && a.dev === b.dev && a.ino === b.ino;
}

/** Why the link structure is not one single-link leaf or one two-link pair, or null. */
function linkProblem(first: PublicationLeaf, second: PublicationLeaf | undefined): string | null {
  if (second === undefined) return first.stat.nlink === 1n ? null : `${first.name} has ${first.stat.nlink} links`;
  return isOneTwoLinkInode(first.stat, second.stat) ? null : `${first.name} and ${second.name} are not exactly one two-link inode`;
}

/** Why `leaves` are not one recognized publication shape, or null. The first leaf problem wins, then the link structure. */
function shapeProblem(leaves: readonly PublicationLeaf[]): string | null {
  for (const leaf of leaves) {
    const problem = leafProblem(leaf);
    if (problem !== null) return problem;
  }
  const [first, second] = leaves;
  return linkProblem(first!, second);
}

/** Read `leaf` through one held no-follow handle whose stamp equals the path's before and after; the caller closes the handle. */
async function readHeld(leaf: PublicationLeaf, maxBytes: number): Promise<{ handle: FileHandle; body: Buffer }> {
  // openFileNoFollow adds only O_NONBLOCK where O_NOFOLLOW exists, so the caller must ask for it (0 keeps the portable path).
  const handle = await openFileNoFollow(leaf.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameStamp(await handle.stat({ bigint: true }), leaf.stat)) throw new Error(`${leaf.name} changed while it was opened`);
    if (leaf.stat.size > BigInt(maxBytes)) throw new Error(`${leaf.name} exceeds ${maxBytes} bytes`);
    const body = Buffer.alloc(Number(leaf.stat.size));
    const { bytesRead } = await handle.read(body, 0, body.length, 0);
    if (bytesRead !== body.length || !sameStamp(await handle.stat({ bigint: true }), leaf.stat)) throw new Error(`${leaf.name} changed while it was read`);
    return { handle, body };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Every leaf still exactly as stamped, the parent still bound. */
async function assertUnchanged(leaves: readonly PublicationLeaf[], parent: ParentBinding): Promise<void> {
  await assertCurrentParent(parent);
  for (const leaf of leaves) {
    const now = await leafAt(leaf.path);
    if (now === null || !sameStamp(now, leaf.stat)) throw new Error(`${leaf.name} changed under the observation`);
  }
}

/** The present leaves of `finalPath` in name order (F, R, W) with their bound parent. */
async function presentLeaves(finalPath: string, confineRoot: string): Promise<{ leaves: PublicationLeaf[]; parent: ParentBinding }> {
  const parent = await assertParentNotSymlink(path.dirname(finalPath), confineRoot, true);
  if (parent === undefined) throw new Error("the publication parent is not confined");
  const names = namesOf(finalPath);
  const leaves: PublicationLeaf[] = [];
  for (const name of ["F", "R", "W"] as const) {
    const stat = await leafAt(names[name]);
    if (stat !== null) leaves.push({ name, path: names[name], stat });
  }
  return { leaves, parent };
}

/** Observe `finalPath`'s publication, keeping the read handle open for a discard (closed for a refusal or absence). */
async function observeHeld(finalPath: string, confineRoot: string, maxBytes: number): Promise<{ observation: PublicationObservation; handle?: FileHandle }> {
  try {
    const { leaves, parent } = await presentLeaves(finalPath, confineRoot);
    if (leaves.length === 0) return { observation: { kind: "absent" } };
    const state = STATES[leaves.map((leaf) => leaf.name).sort().join()];
    if (state === undefined) return { observation: { kind: "refused", reason: `the names ${leaves.map((leaf) => leaf.name).join("+")} are no state the writer leaves` } };
    const problem = shapeProblem(leaves);
    if (problem !== null) return { observation: { kind: "refused", reason: problem } };
    const { handle, body } = await readHeld(leaves[0]!, maxBytes);
    try { await assertUnchanged(leaves, parent); } catch (error) { await handle.close().catch(() => undefined); throw error; }
    return { observation: { kind: "group", state, leaves, body, parent }, handle };
  } catch (error) {
    return { observation: { kind: "refused", reason: error instanceof Error ? error.message : String(error) } };
  }
}

/** Observe the publication of `finalPath` read-only; facts only, every handle closed. */
export async function observePublicationGroup(finalPath: string, confineRoot: string, maxBytes: number): Promise<PublicationObservation> {
  const { observation, handle } = await observeHeld(finalPath, confineRoot, maxBytes);
  await handle?.close().catch(() => undefined);
  return observation;
}

/** Whether any reserved sibling (W or R) of `finalPath` may exist (anything but ENOENT counts). */
export async function publicationAliasesMayExist(finalPath: string): Promise<boolean> {
  const names = namesOf(finalPath);
  for (const file of [names.W, names.R]) {
    try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  }
  return false;
}

/**
 * Unlink `leaf` (alias of a pair, or single-link survivor) after re-checking
 * every `remaining` leaf and the parent, with a sync before and after. The
 * name is recorded in `removed` the moment its unlink succeeds, so a failing
 * sync afterwards still reports that actual effect.
 */
async function unlinkOne(leaf: PublicationLeaf, remaining: readonly PublicationLeaf[], group: { parent: ParentBinding; root: string }, removed: PublicationName[]): Promise<void> {
  const paired = remaining.length === 2;
  await fsyncDirectoryChain(group.parent.dir, group.parent);
  await assertUnchanged(remaining, group.parent);
  if (paired) {
    await removeCommittedTemp(leaf.path, group.parent, leaf.stat);
  } else {
    const outcome = await unlinkConfinedLeafIfIdentity(group.root, leaf.path, path.dirname(leaf.path), (now) => sameStamp(now, leaf.stat));
    if (outcome !== "unlinked") throw new Error(`${leaf.name} changed before its removal`);
  }
  removed.push(leaf.name);
  await fsyncDirectoryChain(group.parent.dir, group.parent);
}

/** The survivor's fresh stamp after its partner's unlink: the same inode, bytes, mode and mtime, now one link. */
async function restamped(leaf: PublicationLeaf): Promise<BigIntStats> {
  const now = await leafAt(leaf.path);
  const same = now !== null && now.dev === leaf.stat.dev && now.ino === leaf.stat.ino && now.size === leaf.stat.size && now.mode === leaf.stat.mode && now.mtimeNs === leaf.stat.mtimeNs;
  if (!same || now.nlink !== 1n) throw new Error(`${leaf.name} changed when its partner was removed`);
  return now;
}

/** Remove the leaves of an abandoned `group` of `finalPath` in the writer's order, recording each removed name; then require all three names absent. */
async function discardInOrder(finalPath: string, group: Extract<PublicationObservation, { kind: "group" }>, root: string, removed: PublicationName[]): Promise<void> {
  for (const name of DISCARD_ORDER[group.state as Exclude<PublicationState, "F">]) {
    const remaining = group.leaves.filter((candidate) => !removed.includes(candidate.name));
    await unlinkOne(remaining.find((candidate) => candidate.name === name)!, remaining, { parent: group.parent, root }, removed);
    const survivor = group.leaves.find((candidate) => !removed.includes(candidate.name));
    if (survivor !== undefined) survivor.stat = await restamped(survivor);
  }
  for (const file of Object.values(namesOf(finalPath))) {
    if ((await leafAt(file)) !== null) throw new Error(`${path.basename(file)} is still present after the discard`);
  }
}

/**
 * Under the caller's lock: re-observe `finalPath`'s abandoned publication
 * (W, W+R, R or R+F), hold its handle while `prove` accepts its exact bytes,
 * and discard it in the writer's order. Refuses (throws) anything else: an
 * unrecognized group, a settled F, an unproved one, or any change. `prove` also
 * receives what is HELD (the leaves the discard will unlink, and their parent),
 * so a caller can bind its own earlier plan to them instead of re-reading paths.
 */
export async function discardProvenPublication(
  finalPath: string, confineRoot: string, maxBytes: number, prove: (state: PublicationState, body: Buffer, held: HeldPublication) => boolean,
): Promise<PublicationState> {
  const { observation, handle } = await observeHeld(finalPath, confineRoot, maxBytes);
  const removed: PublicationName[] = [];
  try {
    if (observation.kind === "absent") throw new PublicationDiscardError("no publication is present", removed);
    if (observation.kind === "refused") throw new PublicationDiscardError(observation.reason, removed);
    if (observation.state === "F") throw new PublicationDiscardError("the publication is settled", removed);
    if (!prove(observation.state, observation.body, { leaves: observation.leaves, parent: observation.parent })) throw new PublicationDiscardError("its owner and content are not proved", removed);
    await discardInOrder(finalPath, observation, confineRoot, removed);
    return observation.state;
  } catch (error) {
    if (error instanceof PublicationDiscardError) throw error;
    throw new PublicationDiscardError(error instanceof Error ? error.message : String(error), removed);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
