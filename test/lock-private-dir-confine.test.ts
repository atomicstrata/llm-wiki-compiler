/**
 * @file test/lock-private-dir-confine.test.ts
 * @description Audit FIX F1: `acquireLock` confines the private `.llmwiki` dir.
 *
 * Before this fix `acquireLock` did `mkdir(<root>/.llmwiki, {recursive})` and
 * created the lock file with NO confinement. A planted `root/.llmwiki ->
 * <out-of-tree>` symlink let the mkdir follow the link and the lock file land
 * OUTSIDE the project root — and `acquireLock` runs FIRST in the page mutation
 * path (before the journal write), so the escape happened up front.
 *
 * Now `acquireLock` resolves + creates the CONFINED private dir and fails CLOSED
 * (returns false, no lock created) when `.llmwiki` (or an ancestor) escapes root.
 * The journal `openBatch` likewise fails closed up front, so
 * `applyApprovedMutations` over a symlinked `.llmwiki` writes NOTHING out of tree.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, symlink, readdir, access, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { applyApprovedMutations } from "../src/trust/executor.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { makeTrustRoot, cleanupTrustRoot, existsUnder } from "./trust/fixture.js";
import type { PlannedMutation, RawPageRef } from "../src/trust/planner.js";

const GOOD_BODY = "---\ntitle: Ok\n---\n\nbody\n";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  root = await makeTrustRoot("lock-private-confine-");
  outsideDir = await mkdtemp(path.join(tmpdir(), "lock-private-outside-"));
});

afterEach(async () => {
  await cleanupTrustRoot(root);
  if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
});

/** True when a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Plant `root/.llmwiki` as a symlink to an out-of-tree directory. */
async function plantPrivateDirSymlink(): Promise<void> {
  await symlink(outsideDir, path.join(root, LLMWIKI_DIR), "dir");
}

/** A hand-built default-page create mutation (its write target is in-tree). */
function pageMutation(): PlannedMutation {
  return {
    kind: "page",
    operation: "create",
    target: { directory: "concepts", slug: "ok" } as RawPageRef,
    body: GOOD_BODY,
    provenance: { origin: "agent", decision: "allow", reviewRouted: false },
  };
}

describe("FIX F1 — acquireLock confines the private .llmwiki dir", () => {
  it("fails closed on a symlinked .llmwiki: no lock created, outside dir untouched", async () => {
    await plantPrivateDirSymlink();
    expect(await acquireLock(root)).toBe(false);
    expect(await readdir(outsideDir)).toEqual([]); // no lock file leaked outside
  });

  it("a real .llmwiki acquires then releases normally (regression)", async () => {
    expect(await acquireLock(root)).toBe(true);
    expect(await existsUnder(root, `${LLMWIKI_DIR}/lock`)).toBe(true);
    await releaseLock(root);
    expect(await existsUnder(root, `${LLMWIKI_DIR}/lock`)).toBe(false);
  });

  it("applyApprovedMutations over a symlinked .llmwiki writes nothing out of tree", async () => {
    await plantPrivateDirSymlink();
    await expect(applyApprovedMutations(root, [pageMutation()])).rejects.toThrow(/could not acquire/);
    expect(await readdir(outsideDir)).toEqual([]); // no journal / lock / page leaked
    expect(await existsUnder(root, "wiki/concepts/ok.md")).toBe(false);
  });

  it("openBatch fails closed up front on a symlinked .llmwiki (held-lock path)", async () => {
    // With the lock already (legitimately) held, a swapped-in escaping .llmwiki
    // must still fail the journal open closed rather than persist out of tree.
    const realPrivate = path.join(root, LLMWIKI_DIR);
    await mkdir(realPrivate, { recursive: true });
    await writeFile(path.join(realPrivate, "lock"), String(process.pid), "utf-8");
    // Replace the real dir with an escaping symlink, holding the (now-orphaned) lock.
    await rm(realPrivate, { recursive: true, force: true });
    await plantPrivateDirSymlink();
    const { openBatch } = await import("../src/trust/journal.js");
    await expect(openBatch(root)).rejects.toThrow(/escapes project root/);
    expect(await exists(path.join(outsideDir, "journal"))).toBe(false);
  });
});
