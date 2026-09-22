/**
 * @file test/preparations/lifecycle-capacity-parity.test.ts
 * @description Capacity compatibility regressions for the Task 9C supplied
 * lifecycle observation. Active and lifecycle physical faults stay fail-closed,
 * quarantine count and bytes retain their literal baseline meaning, prune
 * storage stays outside capacity totals, and semantic pending or unknown state
 * does not create a new staging inventory problem.
 */

import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { plantRegistrySymlink, inventoryWithQuarantineFault } from "./lifecycle-storage-fixture.js";
import {
  writePruneReceipts,
  writeQuarantineReceipts,
  lifecycleSnapshotFixture,
} from "./lifecycle-snapshot-fixture.js";
import { lifecycleRegistryRoot } from "./lifecycle-storage-test-helpers.js";

/** Create the private root and one named lifecycle registry. */
async function registry(root: string, name: "preparation-quarantine" | "preparation-prune") {
  const directory = path.join(root, ".llmwiki", name);
  await mkdir(directory, { recursive: true });
  return directory;
}

describe("supplied lifecycle capacity parity", () => {
  const root = useTempRoot();

  it("poisons compatibility health for an active-only fault", async () => {
    const quarantine = await registry(root.dir, "preparation-quarantine");
    await writeFile(path.join(quarantine, "healthy"), "bytes");
    const decoy = path.join(root.dir, "active-decoy");
    await mkdir(decoy);
    await symlink(decoy, path.join(root.dir, ".llmwiki", "workspaces"));
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems.some((problem) =>
      problem.dimension === "directory-unavailable")).toBe(true);
    expect(inventory.quarantine).toMatchObject({
      count: 1, bytes: 5, health: "unavailable",
    });
  });

  it("names a quarantine-only physical fault and makes health unavailable", async () => {
    const quarantine = await registry(root.dir, "preparation-quarantine");
    const inventory = await inventoryWithQuarantineFault(root.dir, quarantine);
    expect(inventory.quarantine.health).toBe("unavailable");
  });

  it("keeps a prune-only physical fault out of capacity entirely", async () => {
    // Prune is outside quarantine totals, outside the compatibility sum, and was
    // never walked by the baseline scanner. Capacity problems gate staging and
    // handoff settlement, so raising one here is the guard-created dead end design
    // V2 section 5.3 warns against. Prune health lives on the snapshot for the
    // reference/GC consumers that need it.
    const prune = await registry(root.dir, "preparation-prune");
    const outside = path.join(root.dir, "outside");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(prune, "planted"));
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems).toEqual([]);
    expect(inventory.activeBytes).toBe(0);
    expect(inventory.quarantine).toEqual({ count: 0, bytes: 0, health: "ok" });
  });

  it("preserves direct, nested, alias, and hard-link quarantine totals", async () => {
    const quarantine = await registry(root.dir, "preparation-quarantine");
    const first = path.join(quarantine, "x");
    await writeFile(first, "1");
    await writeFile(path.join(quarantine, "x.tmp"), "22");
    await writeFile(path.join(quarantine, "x.writing"), "333");
    await link(first, path.join(quarantine, "x-hard"));
    await mkdir(path.join(quarantine, "qtn-foreign", "nested"), { recursive: true });
    await writeFile(path.join(quarantine, "qtn-foreign", "nested", "leaf"), "4444");
    expect((await scanPreparationInventory(root.dir)).quarantine)
      .toEqual({ count: 5, bytes: 10, health: "ok" });
  });

  it("does not turn continuation-materialized pending units into problems", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeQuarantineReceipts({
      ...fixture, unitId: "qtn-pending", objects: [],
    });
    await writePruneReceipts({
      ...fixture, unitId: "prn-pending", operation: "prune", objects: [],
    });
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems).toEqual([]);
    expect(inventory.quarantine.count).toBe(1);
  });

  it("ignores semantic unknown state when physical storage is healthy", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const quarantine = lifecycleRegistryRoot(fixture.namespace, "quarantine");
    await writeFile(path.join(quarantine, "readable-foreign"), "foreign");
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems).toEqual([]);
    expect(inventory.quarantine)
      .toEqual({ count: 1, bytes: 7, health: "ok" });
  });
});
