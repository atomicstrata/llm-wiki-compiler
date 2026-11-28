/**
 * @file Strict publication checkpoints for one independently bound scale-down leaf.
 * The caller holds the project lock. Compare with expected evidence before any
 * recovery mutation and preserve the inode the original publication created.
 *
 * A process stop after the writer opened its reserved `.writing` scratch but
 * before it linked `.tmp` leaves only that scratch. A replaying caller may
 * discard it only when it is the sole regular single-link inode at that exact
 * name, in the bound parent, with the evidence mode, and its bytes are a prefix
 * of the independently reconstructed value: discarding it then loses no byte
 * the retry does not rewrite. Anything else stays in place and refuses.
 * The retry publishes the value reconstructed from what the caller proves now
 * under its lock; it does not recover the stopped attempt's exact bytes, of
 * which only the shared, never-published prefix is known.
 */
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite } from "../utils/atomic-write.js";
import { assertCurrentParent, fsyncDirectoryChain, type ParentBinding } from "../utils/atomic-write-durability.js";
import { durableTempPath, durableWritingPath, linkTempNoReplace, removeCommittedTemp } from "../utils/atomic-write-no-replace-durable.js";
import { assertAncestorInRoot, assertParentNotSymlink } from "../utils/atomic-write-parent.js";
import { openFileNoFollow } from "../utils/no-follow-open.js";
import { ScaleDowngradeError } from "./downgrade-contracts.js";

/** Permissions of every new publication in this protocol. */
const EVIDENCE_MODE = 0o600;

/** A bounded leaf and the project root that confines it. */
interface EvidenceLeaf {
  readonly root: string;
  readonly relative: string;
  readonly maxBytes: number;
  readonly replayReady?: boolean;
}

/** Return absence only for ENOENT. Every other observation error must refuse. */
async function statLeaf(file: string): Promise<BigIntStats | null> {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Identify a possible alias for the recovery caller. This is a hint, never a proof. */
export async function mayHaveEvidenceAlias(root: string, relative: string): Promise<boolean> {
  const file = path.join(root, relative);
  await assertAncestorInRoot(file, root, true);
  const stat = await statLeaf(file);
  return stat !== null && stat.isFile() && stat.nlink === 2n;
}

/** Compare the fields that must survive a publication link or unlink. */
function sameModeAndContentStamp(a: BigIntStats, b: BigIntStats): boolean {
  return a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** Compare the full-width identity, including stamps changed by an edit or link operation. */
function sameState(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev
    && a.nlink === b.nlink && sameModeAndContentStamp(a, b) && a.ctimeNs === b.ctimeNs;
}

/** Require exactly the destination or the destination and its own reserved alias. */
async function assertNames(file: string, binding: ParentBinding, expected: BigIntStats): Promise<void> {
  await assertCurrentParent(binding);
  const current = await statLeaf(file);
  const alias = await statLeaf(durableTempPath(file));
  const known = expected.nlink === 1n ? alias === null : expected.nlink === 2n && alias !== null && sameState(expected, alias);
  if (current === null || !sameState(expected, current) || !known || await statLeaf(durableWritingPath(file)) !== null) {
    throw new Error("destination or reserved names are not exactly the expected publication");
  }
}

/** Read at most the exact pinned length plus one byte, detecting growth without an unbounded read. */
async function readExactLength(handle: FileHandle, stat: BigIntStats, maxBytes: number): Promise<Buffer> {
  if (stat.size > BigInt(maxBytes)) throw new Error("published evidence exceeds its byte bound");
  const output = Buffer.alloc(Number(stat.size) + 1);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (offset === output.length) throw new Error("published evidence grew during the read");
  }
  if (BigInt(offset) !== stat.size) throw new Error("published evidence shrank during the read");
  return output.subarray(0, offset);
}

/** Keep older readable JSON at one link. Only exact writer bytes can authorize alias removal. */
function matchesExpected(body: Buffer, content: Buffer, links: bigint): boolean {
  if (body.equals(content)) return true;
  if (links !== 1n) return false;
  const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return isDeepStrictEqual(JSON.parse(decode.decode(body)), JSON.parse(decode.decode(content)));
}

/** Unlink only the proved alias after syncing the original link, then require the same sole inode. */
async function settleExisting(file: string, binding: ParentBinding, handle: FileHandle, expected: BigIntStats, stat: Stats): Promise<void> {
  const dir = path.dirname(file);
  await handle.sync();
  await fsyncDirectoryChain(dir, binding);
  await assertNames(file, binding, expected);
  if (expected.nlink === 1n) return;
  await removeCommittedTemp(durableTempPath(file), binding, stat);
  const settled = await handle.stat({ bigint: true });
  if (settled.dev !== expected.dev || settled.ino !== expected.ino || settled.nlink !== 1n
      || settled.size !== expected.size || settled.mode !== expected.mode || settled.mtimeNs !== expected.mtimeNs) {
    throw new Error("destination changed while settling its reserved alias");
  }
  await fsyncDirectoryChain(dir, binding);
  await assertNames(file, binding, settled);
}

/** Recheck and sync an already-visible leaf without rewriting it. */
async function checkpointExisting(leaf: EvidenceLeaf, file: string, content: Buffer): Promise<void> {
  const binding = await assertParentNotSymlink(path.dirname(file), leaf.root, true);
  if (binding === undefined) throw new Error("no confined publication parent");
  const handle = await openFileNoFollow(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const expected = await handle.stat({ bigint: true });
    await assertNames(file, binding, expected);
    if (expected.nlink === 2n && (expected.mode & 0o7777n) !== BigInt(EVIDENCE_MODE)) {
      throw new Error("published alias does not have the required evidence mode");
    }
    const body = await readExactLength(handle, expected, leaf.maxBytes);
    if (!matchesExpected(body, content, expected.nlink)) throw new Error("published bytes do not match this scale-down's evidence");
    await assertNames(file, binding, expected);
    // The low-level unlink helper takes Stats. The full-width checks above bind the same live handle and names.
    await settleExisting(file, binding, handle, expected, await handle.stat());
  } finally {
    await handle.close();
  }
}

/** Bind the ready name, its optional writing alias, and the still-vacant destination. */
async function assertReady(file: string, binding: ParentBinding, expected: BigIntStats): Promise<void> {
  await assertCurrentParent(binding);
  const ready = await statLeaf(durableTempPath(file));
  const writing = await statLeaf(durableWritingPath(file));
  const known = expected.nlink === 1n ? writing === null : expected.nlink === 2n && writing !== null && sameState(expected, writing);
  if (ready === null || !sameState(expected, ready) || !known || await statLeaf(file) !== null) {
    throw new Error("ready names are not exactly the expected pre-publication inode");
  }
}

/** A reserved pre-publication name opened without following a link, with its confined parent's binding. */
interface OpenedReserved {
  readonly dir: string;
  readonly binding: ParentBinding;
  readonly handle: FileHandle;
}

/** Bind the confined parent, then open one reserved name read-only and never through a symlink. */
async function openReserved(leaf: EvidenceLeaf, file: string, reserved: string): Promise<OpenedReserved> {
  const dir = path.dirname(file);
  const binding = await assertParentNotSymlink(dir, leaf.root, true);
  if (binding === undefined) throw new Error("no confined publication parent");
  return { dir, binding, handle: await openFileNoFollow(reserved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) };
}

/** Publish the known ready inode without giving the generic writer unvalidated scratch. */
async function replayReady(leaf: EvidenceLeaf, file: string, content: Buffer): Promise<void> {
  const readyPath = durableTempPath(file);
  const { dir, binding, handle } = await openReserved(leaf, file, readyPath);
  try {
    const ready = await handle.stat({ bigint: true });
    await assertReady(file, binding, ready);
    if ((ready.mode & 0o7777n) !== BigInt(EVIDENCE_MODE) || !(await readExactLength(handle, ready, leaf.maxBytes)).equals(content)) {
      throw new Error("ready mode or bytes do not match this scale-down's publication");
    }
    await handle.sync();
    await fsyncDirectoryChain(dir, binding);
    await assertReady(file, binding, ready);
    if (ready.nlink === 2n) await removeCommittedTemp(durableWritingPath(file), binding, await handle.stat());
    const sole = await handle.stat({ bigint: true });
    if (sole.nlink !== 1n || !sameModeAndContentStamp(sole, ready)) {
      throw new Error("ready inode changed before publication");
    }
    await assertReady(file, binding, sole);
    await linkTempNoReplace(readyPath, file);
    const linked = await handle.stat({ bigint: true });
    if (linked.nlink !== 2n || !sameModeAndContentStamp(linked, ready)) {
      throw new Error("ready inode changed during publication");
    }
    await settleExisting(file, binding, handle, linked, await handle.stat());
  } finally {
    await handle.close();
  }
}

/** Bind the writing scratch as the only reserved name: no ready alias and no destination. */
async function assertWritingOnly(file: string, binding: ParentBinding, expected: BigIntStats): Promise<void> {
  await assertCurrentParent(binding);
  const writing = await statLeaf(durableWritingPath(file));
  if (writing === null || !sameState(expected, writing) || await statLeaf(durableTempPath(file)) !== null || await statLeaf(file) !== null) {
    throw new Error("writing names are not exactly one pre-link publication scratch");
  }
}

/** Remove a writing-only scratch only after proving it holds a prefix of this exact publication. */
async function discardWritingPrefix(leaf: EvidenceLeaf, file: string, content: Buffer): Promise<void> {
  const writingPath = durableWritingPath(file);
  const { dir, binding, handle } = await openReserved(leaf, file, writingPath);
  try {
    const scratch = await handle.stat({ bigint: true });
    await assertWritingOnly(file, binding, scratch);
    if (scratch.nlink !== 1n || (scratch.mode & 0o7777n) !== BigInt(EVIDENCE_MODE)) {
      throw new Error("writing scratch links or mode do not match this scale-down's publication");
    }
    const body = await readExactLength(handle, scratch, content.length);
    if (!content.subarray(0, body.length).equals(body)) throw new Error("writing scratch bytes are not a prefix of this scale-down's evidence");
    await assertWritingOnly(file, binding, scratch);
    // The low-level unlink helper takes Stats. The full-width checks above bind the same live handle and name.
    await removeCommittedTemp(writingPath, binding, await handle.stat());
    await fsyncDirectoryChain(dir, binding);
  } finally {
    await handle.close();
  }
}

/** Finish a ready inode exactly, or discard a proved writing-only prefix so the caller can publish afresh. */
async function replayScratch(leaf: EvidenceLeaf, file: string, content: Buffer): Promise<boolean> {
  if (!leaf.replayReady) throw new Error("destination has unproved publication scratch");
  if (await statLeaf(durableTempPath(file)) !== null) {
    await replayReady(leaf, file, content);
    return true;
  }
  await discardWritingPrefix(leaf, file, content);
  return false;
}

/** Create when positively absent or checkpoint independently expected evidence under the caller's lock. */
export async function publishDowngradeEvidence(leaf: EvidenceLeaf, value: unknown, requireExisting = false): Promise<void> {
  const file = path.join(leaf.root, leaf.relative);
  const content = Buffer.from(`${JSON.stringify(value)}\n`);
  if (content.length > leaf.maxBytes) throw new ScaleDowngradeError("scale_downgrade_blocked", `${leaf.relative} exceeds its evidence byte bound`);
  try {
    await assertAncestorInRoot(file, leaf.root, true);
    if (await statLeaf(file) !== null) return await checkpointExisting(leaf, file, content);
    if (requireExisting) throw new Error("required publication is missing");
    if (await statLeaf(durableTempPath(file)) !== null || await statLeaf(durableWritingPath(file)) !== null) {
      if (await replayScratch(leaf, file, content)) return;
    }
    await atomicWrite(file, content, { confineRoot: leaf.root, exactParent: true, createOnly: true, mode: EVIDENCE_MODE });
  } catch (error) {
    throw new ScaleDowngradeError("scale_downgrade_partial", `${leaf.relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
