/** ONE directory proof for a run of leaves an inventory visit opened ahead of delivering them, instead of one proof per leaf. */

import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { confirmOpenedLeaf, expectedRealMatching, type ConfinedLeafOpen } from "./confined-read.js";
import { realpath } from "./fs-metadata.js";
import { openRegularNoFollow } from "./no-follow-open.js";

const MAX_LEAVES_OPENED_AHEAD = 32;

const MIN_LEAVES_OPENED_AHEAD = 2;

interface LeafOpenedAhead { handle: FileHandle; stat: Stats; directory: string; expectedReal: string | null }

/** The leaves one walk opened ahead, keyed by resolved leaf path. */
export interface LeafReadAhead {
  openRun(root: string, directory: string, run: readonly Dirent[]): Promise<void>;
  claim(leaf: string, parent: string): Promise<ConfinedLeafOpen | undefined>;
  release(leaf: string): Promise<void>;
  releaseAll(): Promise<void>;
}

/** Whether a visit should keep reading entries into the current run. */
export function runContinues(run: readonly Dirent[]): boolean {
  const last = run.at(-1);
  return last !== undefined && last.isFile() && run.length < MAX_LEAVES_OPENED_AHEAD;
}

async function openAhead(leaf: string): Promise<{ handle: FileHandle; stat: Stats } | null> {
  return openRegularNoFollow(leaf, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(() => null);
}

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

/** A new, empty read-ahead for one walk. */
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
