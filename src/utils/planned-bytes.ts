/**
 * @file src/utils/planned-bytes.ts
 * @description Verifying a leaf against its signed plan and acting on it as one
 * operation bound to the object rather than the path.
 *
 * Node 24 exposes no `renameat`/`linkat`, so a path-based commit cannot be made atomic
 * with its checks. This meets the custody floor the repository already establishes —
 * the verified source handle stays OPEN and both parent directories are rebound
 * immediately before the commit — and then goes further: the commit is `link`, which
 * FAILS when the destination exists rather than silently overwriting it, and preserves
 * the inode, so the committed object is the verified object by construction instead of
 * by a later check. `rename` is used only where `link` cannot reach (a cross-device
 * staging slot), under the same rechecks.
 *
 * Hashing streams in bounded chunks against the caller's real ceiling. A private,
 * smaller cap would make legitimately large evidence permanently unmanageable —
 * deadlocking quarantine, reset, prune, and the capacity relief they provide.
 */

import { link, lstat, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { fsyncDirectoryChain } from "./atomic-write-durability.js";
import { openConfinedLeaf, resolveExpectedReal } from "./confined-read.js";
import { lstatLeaf } from "./fs-presence.js";
import { streamConfinedDigest } from "./stream-digest.js";

/** One verify-then-act request against a single planned leaf. */
type VerifiedMutationInput = {
  root: string;
  file: string;
  expectedDir: string;
  plan: { logicalPath: string; byteCount: number; digest: string | null };
  label: string;
  maxBytes: number;
};

type LeafIdentity = { dev: number; ino: number };
type DirectoryBinding = { dir: string; realDir: string; dev: number; ino: number };

/** Capture one non-symlink directory's identity so it can be rebound before a commit. */
async function bindDirectory(dir: string): Promise<DirectoryBinding | null> {
  const resolved = path.resolve(dir);
  const stat = await lstat(resolved).catch(() => null);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  const realDir = await realpath(resolved).catch(() => null);
  return realDir === null ? null : { dir: resolved, realDir, dev: stat.dev, ino: stat.ino };
}

/** Whether a bound directory is still the exact inode and realpath first captured. */
async function stillBound(binding: DirectoryBinding): Promise<boolean> {
  const stat = await lstat(binding.dir).catch(() => null);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (stat.dev !== binding.dev || stat.ino !== binding.ino) return false;
  return (await realpath(binding.dir).catch(() => null)) === binding.realDir;
}

/** Whether the object now at `file` is exactly the one that was verified. */
async function holdsIdentity(file: string, identity: LeafIdentity): Promise<boolean> {
  const leaf = await lstatLeaf(file);
  return leaf.kind === "present" && leaf.stats.dev === identity.dev && leaf.stats.ino === identity.ino;
}

/** Open the planned leaf, prove its bytes, and return it STILL OPEN with its identity. */
async function openVerified(
  input: VerifiedMutationInput,
): Promise<{ handle: FileHandle; identity: LeafIdentity } | "absent"> {
  const { plan, label } = input;
  if (plan.digest === null) throw new Error(`${label} cannot be verified with no planned digest: ${plan.logicalPath}`);
  const opened = await openConfinedLeaf(input.root, input.file, input.expectedDir);
  if (opened.kind === "absent") return "absent";
  if (opened.kind !== "confirmed") throw new Error(`${label} cannot be examined: ${plan.logicalPath}`);
  try {
    const streamed = await streamConfinedDigest(opened, input.maxBytes);
    if (streamed === null) throw new Error(`${label} exceeds the readable ceiling: ${plan.logicalPath}`);
    if (opened.size !== plan.byteCount || streamed.digest !== plan.digest) {
      throw new Error(`${label} changed since the plan was signed: ${plan.logicalPath}`);
    }
    return { handle: opened.handle, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    await opened.handle.close().catch(() => {});
    throw error;
  }
}

/** Prove the leaf matches its plan; `"absent"` means provably gone. */
export async function verifyPlannedBytes(input: VerifiedMutationInput): Promise<LeafIdentity | "absent"> {
  const opened = await openVerified(input);
  if (opened === "absent") return "absent";
  await opened.handle.close().catch(() => {});
  return opened.identity;
}

/**
 * Digest one confined leaf by streaming it, for a plan that is being ENUMERATED
 * rather than checked. Every planned object must carry a digest, so an unreadable or
 * over-ceiling leaf is refused here — at plan time, when refusing costs nothing.
 */
export async function digestPlannedLeaf(root: string, file: string, expectedDir: string, maxBytes: number): Promise<string> {
  const opened = await openConfinedLeaf(root, file, expectedDir);
  if (opened.kind !== "confirmed") throw new Error(`preparation leaf cannot be digested for a plan: ${file}`);
  try {
    const streamed = await streamConfinedDigest(opened, maxBytes);
    if (streamed === null) throw new Error(`preparation leaf exceeds the plannable ceiling: ${file}`);
    return streamed.digest;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Commit the verified object to `target` create-only. `link` fails with EEXIST rather
 * than overwriting an occupant, and preserves the inode, so no separate no-overwrite
 * check can be raced. A cross-device staging slot cannot be linked, so it falls back
 * to `rename` under the caller's already-completed rechecks.
 */
async function commitCreateOnly(file: string, target: string, label: string, logicalPath: string): Promise<void> {
  try {
    await link(file, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`${label} destination slot is already occupied: ${logicalPath}`);
    if (code !== "EXDEV") throw error;
    await rename(file, target);
    return;
  }
  await unlink(file);
}

/**
 * Bind both parent directories, prove the destination parent is the confined one this
 * project expects, and re-assert both bindings — all in the last moment before the
 * commit, so a parent swapped after the checks is refused rather than written through.
 */
async function assertCommitPreconditions(input: VerifiedMutationInput & { targetDir: string }): Promise<void> {
  const sourceParent = await bindDirectory(path.dirname(input.file));
  const targetParent = await bindDirectory(input.targetDir);
  const canonicalTarget = await resolveExpectedReal(input.root, input.targetDir);
  if (sourceParent === null || targetParent === null || canonicalTarget === null
    || targetParent.realDir !== canonicalTarget) {
    throw new Error(`${input.label} destination parent is not confined to the project: ${input.plan.logicalPath}`);
  }
  if (!(await stillBound(sourceParent)) || !(await stillBound(targetParent))) {
    throw new Error(`${input.label} parent directory changed before the commit: ${input.plan.logicalPath}`);
  }
}

/**
 * Prove the leaf, rebind both parents and the object itself, then commit it. Every
 * fact the commit depends on is rechecked in the last moment before the syscall, with
 * the verified handle still open, and the commit cannot overwrite an occupant.
 */
async function mutateVerifiedLeaf(
  input: VerifiedMutationInput & { target: string; targetDir: string },
): Promise<LeafIdentity | "absent"> {
  const opened = await openVerified(input);
  if (opened === "absent") return "absent";
  try {
    await assertCommitPreconditions(input);
    if (!(await holdsIdentity(input.file, opened.identity))) {
      throw new Error(`${input.label} was replaced after verification: ${input.plan.logicalPath}`);
    }
    await commitCreateOnly(input.file, input.target, input.label, input.plan.logicalPath);
    if (!(await holdsIdentity(input.target, opened.identity))) {
      throw new Error(`${input.label} was replaced during the commit: ${input.plan.logicalPath}`);
    }
    // BOTH parents, before any completion can be recorded: persisting only the
    // destination lets a power loss resurrect the source entry beside a completed
    // receipt, leaving live authority next to a finished quarantine or reset.
    await fsyncDirectoryChain(input.targetDir);
    await fsyncDirectoryChain(path.dirname(input.file));
    return opened.identity;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Move the verified object into the quarantine unit, bound to the object it proved. */
export async function moveVerifiedLeaf(
  input: VerifiedMutationInput & { dest: string; destDir: string },
): Promise<"moved" | "absent"> {
  const outcome = await mutateVerifiedLeaf({ ...input, target: input.dest, targetDir: input.destDir });
  return outcome === "absent" ? "absent" : "moved";
}

/**
 * Stage the verified object for deletion, then unlink it. Staging is a DURABLE,
 * resumable step: a crash between the commit and the unlink leaves the bytes
 * discoverable at the staging slot, which {@link deleteStagedLeaf} finishes — the
 * source alone going absent must never be read as a completed delete.
 */
export async function stageAndDeleteLeaf(
  input: VerifiedMutationInput & { staging: string; stagingDir: string; afterStaged?: () => Promise<void> },
): Promise<"deleted" | "absent"> {
  const outcome = await mutateVerifiedLeaf({ ...input, target: input.staging, targetDir: input.stagingDir });
  if (outcome === "absent") return "absent";
  await input.afterStaged?.();
  await unlink(input.staging);
  await fsyncDirectoryChain(path.dirname(input.staging));
  return "deleted";
}

/**
 * Finish a delete whose bytes are already staged: prove the staged object against the
 * signed plan, then unlink it. Resuming from staging must re-prove the bytes, never
 * assume the staging slot holds what the plan described.
 */
export async function deleteStagedLeaf(input: VerifiedMutationInput & { originalDir: string }): Promise<void> {
  const identity = await verifyPlannedBytes(input);
  if (identity === "absent") return;
  if (!(await holdsIdentity(input.file, identity))) {
    throw new Error(`${input.label} staged object was replaced after verification: ${input.plan.logicalPath}`);
  }
  await unlink(input.file);
  await fsyncDirectoryChain(path.dirname(input.file));
  // The original parent may legitimately be gone by now; its fsync is a durability
  // nicety for a directory this delete no longer touches, never a safety check.
  if ((await lstatLeaf(input.originalDir)).kind === "present") await fsyncDirectoryChain(input.originalDir);
}
