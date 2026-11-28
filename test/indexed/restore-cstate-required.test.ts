/**
 * @file test/indexed/restore-cstate-required.test.ts
 * @description The segmented compile state is REQUIRED authority whenever the
 * project's scale record holds its capability (the backup and the restore
 * verify an archive tree by the archive's own store list, so they must not let
 * that list silently omit it). A backup of such a project whose `cstate` store
 * is gone refuses before writing an index; a restore of a backup that lacks
 * `cstate` into such a target refuses before any marker, even when the
 * target's own `cstate` directory is gone (each in a CHILD process).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { backedUp, child, cleanup, compileStateProject, custodyChild, markerPresent, owned, restoreChild } from "./restore-helpers.js";

/** Child chains of real durable writes on the external disk; measured, explicit. */
const CHILD_CHAIN_TIMEOUT_MS = 300_000;

beforeAll(async () => {
  await restoreChild();
  await custodyChild();
}, CHILD_CHAIN_TIMEOUT_MS);
afterEach(cleanup);

/** The `cstate` store directory of `root`. */
const cstateDir = (root: string): string => path.join(root, ".llmwiki", "indexed", "cstate");

/** Rewrite the backup in `dir` without its `cstate` store and the `state.json` it binds (an archive that omits the compile state). */
async function withoutCompileState(dir: string): Promise<void> {
  const file = path.join(dir, "backup.json");
  const index = JSON.parse(await readFile(file, "utf8")) as { stores: { store: string }[]; auxiliary: { relPath: string }[] };
  const stripped = { ...index, stores: index.stores.filter((entry) => entry.store !== "cstate"), auxiliary: index.auxiliary.filter((entry) => entry.relPath !== ".llmwiki/state.json") };
  await writeFile(file, JSON.stringify(stripped));
}

describe("the segmented compile state as required authority", () => {
  it("refuses a backup whose cstate store is missing while the scale record holds the capability", async () => {
    const root = await compileStateProject("cstate-required");
    await rm(cstateDir(root), { recursive: true, force: true });
    const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-cstate-required-backup-"));
    owned.push(dir);
    const made = await child("backup", root, dir);
    expect(made.outcome).not.toBe("ok");
    expect(String(made.message)).toContain("cstate store is missing");
    expect(existsSync(path.join(dir, "backup.json"))).toBe(false);
  }, CHILD_CHAIN_TIMEOUT_MS);

  it("refuses to restore a backup without cstate into a target holding the capability, before any marker, even with the target cstate gone", async () => {
    const root = await compileStateProject("cstate-required");
    const dir = await backedUp(root);
    await withoutCompileState(dir);
    await rm(cstateDir(root), { recursive: true, force: true });
    const restored = await child("restore", root, dir);
    expect(restored.outcome).not.toBe("ok");
    expect(String(restored.message)).toContain("the backup has no cstate store");
    expect(markerPresent(root)).toBe(false);
  }, CHILD_CHAIN_TIMEOUT_MS);
});
