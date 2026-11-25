/**
 * @file test/storage/inventory-leaf-read-ahead.test.ts
 * @description The walk's read-ahead proves a run of leaves' directory ONCE,
 * after the run's last open, and each claim then checks the canonical leaf's
 * identity. These tests pin that the batched proof refuses what the per-leaf
 * confined open refuses: a directory reached through a symlink, and a leaf
 * whose canonical name no longer names the opened inode. A run of one leaf is
 * not opened ahead, so its observation keeps the confined open.
 *
 * Real files on real disk: `leafReadAhead` and `openConfinedLeaf` are the
 * production functions.
 */

import { mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openConfinedLeaf } from "../../src/utils/confined-read.js";
import { leafReadAhead, type LeafReadAhead } from "../../src/utils/inventory-leaf-read-ahead.js";

let root: string, dir: string, ahead: LeafReadAhead;

/** Open every file of `directory` ahead, as one visit's run. */
async function openAll(directory: string): Promise<void> {
  await ahead.openRun(root, directory, await readdir(directory, { withFileTypes: true }));
}

/** The kind each named leaf of `directory` is claimed as. */
async function claimKinds(directory: string, names: readonly string[]): Promise<(string | undefined)[]> {
  const kinds: (string | undefined)[] = [];
  for (const name of names) {
    const claimed = await ahead.claim(path.join(directory, name), directory);
    if (claimed?.kind === "confirmed") await claimed.handle.close();
    kinds.push(claimed?.kind);
  }
  return kinds;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "read-ahead-")));
  dir = path.join(root, "store");
  ahead = leafReadAhead();
  await mkdir(dir);
  await writeFile(path.join(dir, "a"), "alpha");
  await writeFile(path.join(dir, "b"), "beta");
});

afterEach(async () => {
  await ahead.releaseAll();
  await rm(root, { recursive: true, force: true });
});

describe("leaf read-ahead", () => {
  it("confirms each leaf of a run with the identity the confined open proves", async () => {
    await openAll(dir);
    const claimed = await ahead.claim(path.join(dir, "a"), dir);
    const fresh = await openConfinedLeaf(root, path.join(dir, "a"), dir);
    if (claimed?.kind !== "confirmed" || fresh.kind !== "confirmed") throw new Error("expected confirmed opens");
    expect([claimed.dev, claimed.ino, claimed.size, claimed.expectedReal, claimed.canonicalLeaf])
      .toEqual([fresh.dev, fresh.ino, fresh.size, fresh.expectedReal, fresh.canonicalLeaf]);
    await Promise.all([claimed.handle.close(), fresh.handle.close()]);
    expect(await claimKinds(dir, ["b", "a"])).toEqual(["confirmed", undefined]);
  });

  it("refuses every leaf of a run whose directory is reached through a symlink", async () => {
    const linked = path.join(root, "linked");
    await symlink(dir, linked);
    await openAll(linked);
    expect(await claimKinds(linked, ["a", "b"])).toEqual(["unavailable", "unavailable"]);
    expect((await openConfinedLeaf(root, path.join(linked, "a"), linked)).kind).toBe("unavailable");
  });

  it("refuses a leaf whose canonical name stopped naming the opened inode", async () => {
    await openAll(dir);
    await writeFile(path.join(dir, "next"), "replacement");
    await rename(path.join(dir, "next"), path.join(dir, "a"));
    expect(await claimKinds(dir, ["a", "b"])).toEqual(["unavailable", "confirmed"]);
  });

  it("opens nothing ahead for a run of one leaf, or for a different parent", async () => {
    await rm(path.join(dir, "b"));
    await openAll(dir);
    expect(await claimKinds(dir, ["a"])).toEqual([undefined]);
    await writeFile(path.join(dir, "b"), "beta");
    await openAll(dir);
    expect(await ahead.claim(path.join(dir, "a"), root)).toBeUndefined();
  });
});
