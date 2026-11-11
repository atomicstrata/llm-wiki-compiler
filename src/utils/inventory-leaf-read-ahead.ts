/**
 * @file src/utils/inventory-leaf-read-ahead.ts
 * @description ONE directory proof for a run of leaves an inventory visit opened
 * ahead of delivering them, instead of one proof per leaf.
 *
 * WHY. Every leaf the walk observes needs the confined-open proof of
 * `openConfinedLeaf` (`confined-read.ts`): open the literal leaf no-follow and
 * `fstat` the handle; THEN `realpath` the parent and require its canonical
 * in-root form; THEN `lstat` the canonical leaf and require the handle's
 * `{dev, ino}`. The parent realpath must come after the open (a directory
 * swapped for a symlink just before the open, and swapped back, is caught only
 * by the identity check that follows a later canonical parent), so the walk's
 * own check before listing the directory cannot stand in for it. Asked per
 * leaf, a directory of N leaves pays N realpaths of that same directory.
 *
 * WHAT THIS DOES. A visit reads ahead a run of consecutive regular-file entries
 * (at most {@link MAX_LEAVES_OPENED_AHEAD}, ended by any other entry or the end
 * of the listing). When the run holds two or more, it opens each of them
 * exactly as `openConfinedLeaf` does, and only AFTER THE LAST OPEN realpaths
 * the directory once. The walk's later observation of each leaf claims its
 * handle and `lstat`s the canonical leaf then. For every leaf the order is the
 * per-leaf proof's own: open, then a canonical parent realpath, then the
 * canonical identity check, with the handle held open from the open through the
 * check (so the inode cannot be freed and reused in between). A leaf whose
 * proof fails is `unavailable`, as it is there; a leaf whose early open failed
 * is not held, and its observation opens it afresh through `openConfinedLeaf`,
 * which decides absent or unavailable as before.
 *
 * BOUNDS. At most {@link MAX_LEAVES_OPENED_AHEAD} handles are held at once: a
 * run stops at the first non-file entry, so every handle of a run is claimed or
 * closed before the visit descends into a subdirectory. A leaf opened ahead and
 * never observed (the scanner skipped it, or the entry bound ran out) is closed
 * when the visit moves past it. Nothing here records a problem or names a store.
 */

import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { confirmOpenedLeaf, expectedRealMatching, type ConfinedLeafOpen } from "./confined-read.js";
import { realpath } from "./fs-metadata.js";
import { openRegularNoFollow } from "./no-follow-open.js";

/** The most consecutive leaves one visit opens ahead, and so the most handles it holds at once. */
const MAX_LEAVES_OPENED_AHEAD = 32;

/** The fewest leaves in a run worth opening ahead: one leaf needs its own directory proof either way. */
const MIN_LEAVES_OPENED_AHEAD = 2;

/** One leaf opened ahead: its handle and `fstat`, its directory, and that directory's proof after the run's last open. */
interface LeafOpenedAhead { handle: FileHandle; stat: Stats; directory: string; expectedReal: string | null }

/** The leaves one walk opened ahead, keyed by resolved leaf path. Shared by its directory visits and leaf observations. */
export interface LeafReadAhead {
  /** Open every regular-file entry of `run` in `directory`, then prove the directory once. */
  openRun(root: string, directory: string, run: readonly Dirent[]): Promise<void>;
  /** The confined open of a leaf opened ahead under `parent`, consuming it; undefined when it was not. */
  claim(leaf: string, parent: string): Promise<ConfinedLeafOpen | undefined>;
  /** Close a leaf opened ahead that no observation claimed. */
  release(leaf: string): Promise<void>;
  /** Close every leaf still held. */
  releaseAll(): Promise<void>;
}

/** Whether a visit should keep reading entries into the current run. */
export function runContinues(run: readonly Dirent[]): boolean {
  const last = run.at(-1);
  return last !== undefined && last.isFile() && run.length < MAX_LEAVES_OPENED_AHEAD;
}

/** Open one leaf as `openConfinedLeaf` does, or null when that open fails (its observation then opens it afresh). */
async function openAhead(leaf: string): Promise<{ handle: FileHandle; stat: Stats } | null> {
  return openRegularNoFollow(leaf, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(() => null);
}

/** Open the run's files, then take the ONE directory proof that follows every one of those opens. */
async function openRunOf(root: string, directory: string, run: readonly Dirent[]): Promise<Map<string, LeafOpenedAhead>> {
  const files = run.filter((entry) => entry.isFile()), opened = new Map<string, LeafOpenedAhead>();
  if (files.length < MIN_LEAVES_OPENED_AHEAD) return opened;
  const resolved = path.resolve(directory), handles: [string, { handle: FileHandle; stat: Stats }][] = [];
  for (const entry of files) {
    const leaf = path.join(resolved, entry.name), open = await openAhead(leaf);
    if (open !== null) handles.push([leaf, open]);
  }
  if (handles.length === 0) return opened;
  const expectedReal = await expectedRealMatching(root, resolved, await realpath(resolved).catch(() => null));
  for (const [leaf, open] of handles) opened.set(leaf, { ...open, directory: resolved, expectedReal });
  return opened;
}

/** A new, empty read-ahead for one walk. PURE to build. */
export function leafReadAhead(): LeafReadAhead {
  const held = new Map<string, LeafOpenedAhead>();
  const release = async (leaf: string) => {
    const ahead = held.get(leaf);
    if (ahead === undefined) return;
    held.delete(leaf);
    await ahead.handle.close().catch(() => {});
  };
  return {
    openRun: async (root, directory, run) => {
      for (const [leaf, ahead] of await openRunOf(root, directory, run)) {
        await release(leaf);
        held.set(leaf, ahead);
      }
    },
    claim: async (leaf, parent) => {
      const key = path.resolve(leaf), ahead = held.get(key);
      if (ahead === undefined || ahead.directory !== path.resolve(parent)) return undefined;
      held.delete(key);
      return confirmOpenedLeaf(ahead.handle, ahead.stat, leaf, ahead.expectedReal);
    },
    release: (leaf) => release(path.resolve(leaf)),
    releaseAll: async () => { for (const leaf of [...held.keys()]) await release(leaf); },
  };
}
