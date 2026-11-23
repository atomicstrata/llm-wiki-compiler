/**
 * @file test/indexed/gc.test.ts
 * @description Segment collection on real disk: the preview names exactly
 * the unreferenced segments, an apply (in a fresh child process) deletes
 * exactly those and every row still reads, pins protect their segments, and
 * a plan made stale by a commit, a pin or a replaced candidate deletes
 * nothing. The operator's offline assertion is required. A deletion that
 * fails in a later store reports exactly what earlier stores lost.
 */

import { chmod, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterAll, afterEach, beforeAll } from "../config/storage-profile-hooks.js";
import { applyGc } from "../../src/indexed/gc.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { catalogPin, catalogUnpin } from "../../src/indexed/maintenance.js";
import { builtProject, gcMode as child, gcChild, savedPlan, storeLeaves, storePreview, removeBases } from "./gc-helpers.js";

/**
 * The two cases below chain many durable child commits (seven commits plus an
 * apply; the first two-store base build of eighteen commits); on the
 * EJ8T-backed image they measured past the 30 s default, so each gets an
 * explicit, measured limit.
 */
const DURABLE_CHAIN_TIMEOUT_MS = 120_000;

/**
 * The pin case reached its explicit 120 s limit after pin setup and only three
 * of seven durable commits on slow external storage. The two-store case also
 * performs eighteen base commits, beyond the nine-commit one-store setup
 * that measured about 200 s.
 * These two cases get a fixed allowance only under the explicit slow profile;
 * their original normal-storage limit and every assertion stay unchanged.
 */
const DURABLE_CHAIN_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** The two durable chains' limit for the explicitly selected storage profile. */
const durableChainTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? DURABLE_CHAIN_SLOW_STORAGE_TIMEOUT_MS
  : DURABLE_CHAIN_TIMEOUT_MS;
const ROWS = Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`k${at}`, `K${at}`]));
const roots: string[] = [];
beforeAll(async () => { await gcChild(); });
afterAll(removeBases);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A built project, removed after the test. */
async function project(...stores: string[]): Promise<string> {
  const root = await builtProject("llmwiki-gc-", ...stores);
  roots.push(root);
  return root;
}

describe("preview and apply", () => {
  it("previews the eight superseded gcfix segments and deletes exactly them", async () => {
    const root = await project();
    const { preview, planFile } = await savedPlan(root);
    const fix = storePreview(preview, "gcfix");
    expect([preview.admissible, "candidates" in fix, fix.referencedSegments]).toEqual([true, false, 2]);
    expect(fix.sample.length).toBeGreaterThan(0);
    const before = await storeLeaves(root, "gcfix");
    const applied = await child("apply", root, planFile);
    expect(applied.outcome).toBe("ok");
    const after = await storeLeaves(root, "gcfix");
    expect(before.length - after.length).toBe(8);
    expect(after.filter((name) => name.endsWith(".seg"))).toHaveLength(2);
    expect(((await child("read", root, "gcfix")).result as { rows: unknown }).rows).toEqual(ROWS);
    expect((await savedPlan(root)).preview.reclaimableLeaves).toBe(0);
  });

  it("refuses without the operator's offline assertion, deleting nothing", async () => {
    const root = await project();
    const { preview } = await savedPlan(root);
    await expect(applyGc(root, preview.plan)).rejects.toThrow(/indexed_gc_offline_unconfirmed/);
    expect((await savedPlan(root)).preview.reclaimableLeaves).toBe(preview.reclaimableLeaves);
  });

  it("refuses a malformed plan", async () => {
    const root = await project();
    const { preview } = await savedPlan(root);
    const bad = { ...preview.plan, stores: [{ ...preview.plan.stores[0]!, candidateCount: -1 }] };
    await expect(applyGc(root, bad, { readersOffline: true })).rejects.toThrow(/indexed_gc_plan_invalid/);
  });
});

describe("stale plans delete nothing", () => {
  /** Apply `planFile` in a child, expect a stale refusal and the same candidates. */
  async function expectStale(root: string, planFile: string): Promise<void> {
    const before = await storeLeaves(root, "gcfix");
    expect((await child("apply", root, planFile)).outcome).toBe("indexed_gc_plan_stale");
    expect(await storeLeaves(root, "gcfix")).toEqual(before);
  }

  it("after a commit", async () => {
    const root = await project();
    const { planFile } = await savedPlan(root);
    expect((await child("commit", root, "gcfix", "k9")).outcome).toBe("ok");
    await expectStale(root, planFile);
  });

  it("after a pin is added", async () => {
    const root = await project();
    const { planFile } = await savedPlan(root);
    await catalogPin(root, "before-gc");
    await expectStale(root, planFile);
  });

  it("after a candidate leaf is replaced by a different file of the same name", async () => {
    const root = await project();
    const { preview, planFile } = await savedPlan(root);
    const name = storePreview(preview, "gcfix").sample[0]!;
    const leaf = path.join(root, ".llmwiki", "indexed", "gcfix", name);
    const size = (await stat(leaf)).size;
    await rm(leaf);
    await writeFile(leaf, Buffer.alloc(size));
    await expectStale(root, planFile);
  });
});

describe("pins", () => {
  it("protect the pinned manifest's segments until unpinned", async () => {
    const root = await project();
    await catalogPin(root, "keep");
    for (const key of ["k9", "k10", "k11", "k12", "k13", "k14", "k15"]) expect((await child("commit", root, "gcfix", key)).outcome).toBe("ok");
    const pinned = storePreview((await savedPlan(root)).preview, "gcfix");
    const { planFile } = await savedPlan(root);
    expect((await child("apply", root, planFile)).outcome).toBe("ok");
    const kept = await storeLeaves(root, "gcfix");
    await catalogUnpin(root, "keep");
    const unpinned = storePreview((await savedPlan(root)).preview, "gcfix");
    expect(unpinned.candidateBytes).toBeGreaterThan(0);
    expect(pinned.referencedSegments).toBe(unpinned.referencedSegments);
    expect(kept.length).toBeGreaterThan(unpinned.referencedSegments + 1);
  }, durableChainTimeoutMs);

  it("an incomplete pin blocks the collection", async () => {
    const root = await project();
    await catalogPin(root, "half");
    await rm(path.join(root, ".llmwiki", "indexed-pins", "half", "pin.json"));
    const { preview, planFile } = await savedPlan(root);
    expect(preview.admissible).toBe(false);
    expect((await child("apply", root, planFile)).outcome).toBe("indexed_gc_blocked");
    await catalogUnpin(root, "half");
    expect((await savedPlan(root)).preview.admissible).toBe(true);
  });
});

describe("blockers", () => {
  it("a lost manifest beside segments, a segment-named symlink, an unexpected entry", async () => {
    const root = await project();
    const indexed = path.join(root, ".llmwiki", "indexed");
    await rename(path.join(indexed, "gcfix", "manifest.json"), path.join(indexed, "gcfix", "manifest.json.lost"));
    await symlink("/etc/hosts", path.join(indexed, "catalog", "r999-0-0000abcd.seg"));
    await writeFile(path.join(indexed, "stray.txt"), "x");
    const { preview, planFile } = await savedPlan(root);
    const text = preview.blockers.join("\n");
    expect(text).toMatch(/gcfix has segments but no manifest/);
    expect(text).toMatch(/r999-0-0000abcd.seg is not a regular single-link file/);
    expect(text).toMatch(/unexpected entry stray.txt/);
    expect((await child("apply", root, planFile)).outcome).toBe("indexed_gc_blocked");
  });
});

describe("a deletion that fails part-way", () => {
  it("reports the exact counts of the stores already collected", async () => {
    const root = await project("gcfix", "gcfiz");
    const { planFile } = await savedPlan(root);
    const later = path.join(root, ".llmwiki", "indexed", "gcfiz");
    await chmod(later, 0o500);
    try {
      const failed = await child("apply", root, planFile);
      expect(failed.outcome).toBe("indexed_gc_partial");
      const partial = failed.partial as { deletedLeaves: number; stores: { store: string; deletedLeaves: number }[] };
      expect(partial.stores.find((entry) => entry.store === "gcfix")?.deletedLeaves).toBe(8);
      expect(partial.stores.some((entry) => entry.store === "gcfiz")).toBe(false);
      expect(partial.deletedLeaves).toBe(partial.stores.reduce((sum, entry) => sum + entry.deletedLeaves, 0));
    } finally {
      await chmod(later, 0o700);
    }
    const preview = (await savedPlan(root)).preview;
    expect([storePreview(preview, "gcfix").candidateBytes, storePreview(preview, "gcfiz").sample.length]).toEqual([0, 5]);
  }, durableChainTimeoutMs);
});
