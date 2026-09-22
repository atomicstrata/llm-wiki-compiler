/**
 * @file Deterministic regression for the lock's double-ownership window.
 * @description The defect these cases pin was carried for months as a
 * "load-sensitive flake" in the concurrent relation-store test, because the only
 * evidence for it was an occasional broken event chain under parallel CI shards
 * — and every re-run passed. It is not a scheduling artifact. Acquisition used
 * to create the authoritative lock name and write the owner record into it as
 * two steps, so the lock was briefly a zero-byte file; `isLockStale` reports an
 * unreadable owner as stale (it must, or a corrupt lock would strand the
 * project forever), so a contender arriving in that window reclaimed the lock
 * from a LIVE acquirer and both processes proceeded believing they held it.
 *
 * These cases hold that interval open with a publication seam rather than
 * racing for it, so the property is asserted instead of sampled. Against the
 * old create-then-write implementation the first two fail on every run, not
 * occasionally — which is the whole point.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { LOCK_FILE } from "../src/utils/constants.js";

/** One throwaway project root per case, removed on the way out. */
async function withProjectRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-lock-race-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Read the published owner record, or `null` when no lock leaf is present. */
async function readLockLeaf(root: string): Promise<string | null> {
  return readFile(path.join(root, LOCK_FILE), "utf-8").catch(() => null);
}

/**
 * Acquire while a contender publishes from inside the paused interval,
 * recording every observation the seam makes so no assertion depends on
 * variable narrowing across the closure boundary.
 */
async function acquireAgainstContender(root: string): Promise<{
  firstWon: boolean;
  contenderWon: boolean[];
  leafDuringPause: (string | null)[];
}> {
  const contenderWon: boolean[] = [];
  const leafDuringPause: (string | null)[] = [];
  const firstWon = await acquireLock(root, {
    quiet: true,
    hooks: {
      beforePublish: async () => {
        contenderWon.push(await acquireLock(root, { quiet: true }));
        leafDuringPause.push(await readLockLeaf(root));
      },
    },
  });
  return { firstWon, contenderWon, leafDuringPause };
}

describe("lock publication under a contender", () => {
  it("gives the lock to exactly one acquirer when a contender publishes mid-acquisition", async () => {
    await withProjectRoot(async (root) => {
      const observed = await acquireAgainstContender(root);

      expect(observed.contenderWon).toEqual([true]);
      expect(observed.firstWon).toBe(false);
      await releaseLock(root);
    });
  });

  it("leaves the winner's record under the lock name, untouched by the loser", async () => {
    await withProjectRoot(async (root) => {
      const observed = await acquireAgainstContender(root);

      // The loser must not overwrite, truncate, or unlink what the winner published.
      expect(observed.leafDuringPause[0]).not.toBeNull();
      expect(await readLockLeaf(root)).toBe(observed.leafDuringPause[0]);
      await releaseLock(root);
    });
  });

  it("leaves no scratch leaf behind after a lost publication", async () => {
    await withProjectRoot(async (root) => {
      await acquireAgainstContender(root);

      const leaves = await readdir(path.join(root, path.dirname(LOCK_FILE)));
      expect(leaves.filter((leaf) => leaf.includes(".publishing"))).toEqual([]);
      await releaseLock(root);
    });
  });

  it("still publishes normally when the paused interval goes uncontested", async () => {
    await withProjectRoot(async (root) => {
      const paused: true[] = [];
      const acquired = await acquireLock(root, {
        quiet: true,
        hooks: { beforePublish: async () => { paused.push(true); } },
      });

      expect(paused).toEqual([true]);
      expect(acquired).toBe(true);
      expect(await readLockLeaf(root)).toContain(`"pid":${process.pid}`);
      await releaseLock(root);
    });
  });
});
