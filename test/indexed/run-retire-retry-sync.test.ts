/**
 * @file test/indexed/run-retire-retry-sync.test.ts
 * @description Exercise real quarantine rename, receipt discovery and moved
 * cleanup after either parent sync fails in an isolated synthetic project.
 */

import { expect, it, spyOn } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finishCleanup, quarantineInventory, RETIRING_DIR, retireStore, storeLeaves } from "../../src/indexed/run-retire-quarantine.js";
import { INDEXED_DIR, MANIFEST_LEAF } from "../../src/segments/contracts.js";
import { sha256Hex } from "../../src/segments/format.js";
import * as confined from "../../src/utils/confined-delete.js";

const STORE = "crun-000000000001";
const NEIGHBOR = "crun-000000000002";
const SEGMENT = "r1-1-0123abcd.seg";
const PARENTS = [INDEXED_DIR, RETIRING_DIR] as const;

/** Create an owned two-leaf store and a neighboring live store. */
async function retirementFixture(root: string) {
  const live = path.join(root, INDEXED_DIR, STORE);
  const moved = path.join(root, RETIRING_DIR, STORE);
  const receipt = `${moved}.receipt.json`;
  const neighbor = path.join(root, INDEXED_DIR, NEIGHBOR, MANIFEST_LEAF);
  const manifest = "synthetic manifest\n";
  await mkdir(live, { recursive: true });
  await mkdir(path.dirname(neighbor));
  await writeFile(path.join(live, MANIFEST_LEAF), manifest);
  await writeFile(path.join(live, SEGMENT), "synthetic segment\n");
  await writeFile(neighbor, "neighbor\n");
  const leaves = await storeLeaves(root, path.relative(root, live), live);
  if (typeof leaves === "string") throw new Error(leaves);
  const target = { store: STORE, eligibility: "done-not-last-run" as const, manifestSha256: sha256Hex(Buffer.from(manifest)), leafDigest: leaves.digest };
  return { live, moved, receipt, neighbor, target };
}

/** Fail only the selected confined parent sync and trace completed syncs and unlinks. */
function watchCleanup(root: string, failingParent: string) {
  const sync = confined.fsyncConfinedDirectory;
  const unlink = confined.unlinkConfinedLeafIfIdentity;
  const trace: string[] = [];
  const fault = new Error(`synthetic directory sync failure at ${failingParent}`);
  let faultActive = true;
  const syncSpy = spyOn(confined, "fsyncConfinedDirectory").mockImplementation(async (project, dir) => {
    const relative = path.relative(root, dir);
    if (project === root && faultActive && relative === failingParent) throw fault;
    await sync(project, dir);
    if (project === root) trace.push(`sync:${relative}`);
  });
  const unlinkSpy = spyOn(confined, "unlinkConfinedLeafIfIdentity").mockImplementation(async (project, leaf, dir, matches) => {
    if (project === root) trace.push(`unlink:${path.relative(root, leaf)}`);
    return unlink(project, leaf, dir, matches);
  });
  return {
    trace, fault,
    clearFault() { faultActive = false; trace.length = 0; },
    restore() { unlinkSpy.mockRestore(); syncSpy.mockRestore(); },
  };
}

for (const parent of PARENTS) {
  /** A moved retry cannot unlink owned leaves until both parent syncs complete. */
  it(`syncs both rename parents before moved cleanup after ${parent} fails`, async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), "llmwiki-retire-sync-"));
    const observed = watchCleanup(root, parent);
    const committed: string[] = [];
    const reclaimed: number[] = [];
    const progress = { committed: (store: string) => { committed.push(store); }, reclaimed: (bytes: number) => { reclaimed.push(bytes); } };
    try {
      const fixture = await retirementFixture(root);
      const original = await lstat(fixture.live, { bigint: true });
      await expect(retireStore(root, fixture.target, "a".repeat(32), progress)).rejects.toBe(observed.fault);
      expect(committed).toEqual([STORE]);
      await expect(lstat(fixture.live)).rejects.toMatchObject({ code: "ENOENT" });
      const moved = await lstat(fixture.moved, { bigint: true });
      expect([moved.dev, moved.ino]).toEqual([original.dev, original.ino]);
      const receipt = await readFile(fixture.receipt);
      expect((await readdir(fixture.moved)).sort()).toEqual([MANIFEST_LEAF, SEGMENT]);
      const inventory = await quarantineInventory(root);
      expect(inventory).toEqual({ blockers: [], pending: [{ store: STORE, phase: "moved", receiptSha256: sha256Hex(receipt) }] });
      await expect(finishCleanup(root, inventory.pending[0], progress)).rejects.toBe(observed.fault);
      expect(await readFile(fixture.receipt)).toEqual(receipt);
      expect((await readdir(fixture.moved)).sort()).toEqual([MANIFEST_LEAF, SEGMENT]);
      expect(reclaimed).toEqual([]);
      expect(observed.trace.filter((step) => step.startsWith("unlink:"))).toEqual([]);

      observed.clearFault();
      await finishCleanup(root, inventory.pending[0], progress);
      expect(observed.trace.slice(0, 2)).toEqual(PARENTS.map((dir) => `sync:${dir}`));
      expect(observed.trace[2]).toStartWith(`unlink:${RETIRING_DIR}/${STORE}/`);
      expect(reclaimed).toHaveLength(2);
      expect(await readdir(path.join(root, RETIRING_DIR))).toEqual([]);
      expect(await readFile(fixture.neighbor, "utf8")).toBe("neighbor\n");
      expect(committed).toEqual([STORE]);
    } finally {
      observed.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
}
