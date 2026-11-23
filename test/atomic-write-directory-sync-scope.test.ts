/**
 * @file test/atomic-write-directory-sync-scope.test.ts
 * @description The opt-in batch {@link DirectorySyncScope} on strict
 * create-only publication, observed through the existing
 * `beforeDirectorySyncForTest` seam (called before every real directory fsync).
 * Without a scope every write syncs the whole chain at all three protocol
 * points, exactly as before. With a scope, the first write syncs the whole
 * chain once and later writes in the same batch sync only their leaf parent,
 * unless the freshly observed chain differs: a new directory, or a subtree
 * moved under a recreated grandparent at the same lexical path, is synced
 * again. A failed sync anchors nothing; retired, foreign-root and non-create-only
 * uses are refused.
 */

import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "./config/storage-profile-hooks.js";
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite, atomicWriteNoReplaceDurable } from "../src/utils/atomic-write.js";
import { DirectorySyncScope } from "../src/utils/directory-sync-scope.js";

let root = "";
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dir-sync-scope-"))); });
afterEach(() => rm(root, { recursive: true, force: true }));

/** Root-relative names of the directories synced, in order. */
let synced: string[] = [];
/** Fail the sync of this root-relative directory once, when set. */
let failOnce: string | null = null;

/** Publish one create-only leaf under `root`, recording each directory sync. */
async function publish(rel: string, scope?: DirectorySyncScope): Promise<void> {
  await atomicWriteNoReplaceDurable(path.join(root, rel), `body of ${rel}`, {
    confineRoot: root, exactParent: true, directorySyncScope: scope,
    beforeDirectorySyncForTest: async (dir) => {
      const name = path.relative(root, dir) || ".";
      if (name === failOnce) { failOnce = null; throw new Error(`injected sync failure: ${name}`); }
      synced.push(name);
    },
  });
}

/** Directory syncs made by one publication. */
async function syncsOf(rel: string, scope?: DirectorySyncScope): Promise<string[]> {
  synced = [];
  await publish(rel, scope);
  return synced;
}

const FULL_CHAIN = ["g/p", "g", "."];

describe("strict create-only without a scope", () => {
  it("syncs the whole chain at all three points on every write (unchanged trace)", async () => {
    expect(await syncsOf("g/p/a.json")).toEqual([...FULL_CHAIN, ...FULL_CHAIN, ...FULL_CHAIN]);
    expect(await syncsOf("g/p/b.json")).toEqual([...FULL_CHAIN, ...FULL_CHAIN, ...FULL_CHAIN]);
  });
});

describe("strict create-only with a batch scope", () => {
  it("syncs the chain once, then only leaf parents, and every file still publishes", async () => {
    const scope = new DirectorySyncScope(root);
    expect(await syncsOf("g/p/a.json", scope)).toEqual([...FULL_CHAIN, "g/p", "g/p"]);
    expect(await syncsOf("g/p/b.json", scope)).toEqual(["g/p", "g/p", "g/p"]);
    expect(await readFile(path.join(root, "g/p/b.json"), "utf8")).toBe("body of g/p/b.json");
  });

  it("syncs a directory created mid-batch up to the first anchored chain", async () => {
    const scope = new DirectorySyncScope(root);
    await publish("g/p/a.json", scope);
    expect(await syncsOf("g/p/new/b.json", scope)).toEqual(["g/p/new", "g/p", "g/p/new", "g/p/new"]);
  });

  it("re-syncs a subtree moved under a recreated grandparent at the same lexical path", async () => {
    const scope = new DirectorySyncScope(root);
    await publish("g/p/a.json", scope);
    await rename(path.join(root, "g"), path.join(root, "g-old"));
    await mkdir(path.join(root, "g"));
    await rename(path.join(root, "g-old/p"), path.join(root, "g/p"));
    expect(await syncsOf("g/p/b.json", scope)).toEqual([...FULL_CHAIN, "g/p", "g/p"]);
  });

  it("anchors nothing when an ancestor sync fails, so the next write walks the chain again", async () => {
    const scope = new DirectorySyncScope(root);
    failOnce = "g";
    await expect(publish("g/p/a.json", scope)).rejects.toThrow(/injected sync failure/);
    expect(await syncsOf("g/p/b.json", scope)).toEqual([...FULL_CHAIN, "g/p", "g/p"]);
  });
});

describe("scope binding", () => {
  it("refuses a retired scope, a foreign-root scope and a non-create-only write", async () => {
    const retired = new DirectorySyncScope(root);
    retired.retire();
    await expect(publish("g/p/a.json", retired)).rejects.toThrow(/retired/);
    await expect(publish("g/p/a.json", new DirectorySyncScope(path.join(root, "elsewhere")))).rejects.toThrow(/another project root/);
    const scope = new DirectorySyncScope(root);
    await expect(atomicWrite(path.join(root, "x.json"), "x", { confineRoot: root, directorySyncScope: scope }))
      .rejects.toThrow(/only supported for create-only/);
  });
});
