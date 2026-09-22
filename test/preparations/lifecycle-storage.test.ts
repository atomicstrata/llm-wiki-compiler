/**
 * @file test/preparations/lifecycle-storage.test.ts
 * @description Exact physical-storage regressions for the Task 9C lifecycle
 * snapshot. The suite distinguishes literal path count, physical inode bytes,
 * semantic classifier completeness, and bounded traversal consumption.
 */

import { link, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import {
  lifecycleSnapshotFixture,
} from "./lifecycle-snapshot-fixture.js";
import { lifecycleRegistryRoot } from "./lifecycle-storage-test-helpers.js";

type Registry = "quarantine" | "prune";
type Snapshot = Awaited<ReturnType<typeof scanPreparationLifecycle>>;

/** Scan the fixture's already-bound namespace after adding physical content. */
async function scan(
  namespace: Parameters<typeof scanPreparationLifecycle>[0],
): Promise<Snapshot> {
  return scanPreparationLifecycle(namespace);
}

/** Add the same ordinary/hard-link/alias sequence used by monotonicity checks. */
async function addMonotonicFiles(root: string, observe: () => Promise<Snapshot>, registry: Registry) {
  const values: Array<{ count: number; bytes: number }> = [];
  const first = path.join(root, "ordinary");
  await writeFile(first, "four");
  values.push((await observe()).storage[registry]);
  await link(first, path.join(root, "hard-link"));
  values.push((await observe()).storage[registry]);
  await writeFile(path.join(root, "x.tmp"), "aa");
  values.push((await observe()).storage[registry]);
  await writeFile(path.join(root, "x.writing"), "bbb");
  values.push((await observe()).storage[registry]);
  return values;
}

describe("preparation lifecycle physical storage", () => {
  const root = useTempRoot();

  it("accounts a direct quarantine-root regular file before classification", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    await writeFile(path.join(lifecycleRegistryRoot(
      fixture.namespace, "quarantine",
    ), "foreign"), "bytes");
    const snapshot = await scan(fixture.namespace);
    expect(snapshot.storage.quarantine).toEqual({
      count: 1, bytes: 5, health: "ok", traversalEntries: 1,
    });
    expect(snapshot.complete).toBe(false);
    expect(Object.isFrozen(snapshot.storage.quarantine)).toBe(true);
  });

  it("counts x, x.tmp, and x.writing as three literal paths", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const registry = lifecycleRegistryRoot(fixture.namespace, "quarantine");
    await writeFile(path.join(registry, "x"), "1");
    await writeFile(path.join(registry, "x.tmp"), "22");
    await writeFile(path.join(registry, "x.writing"), "333");
    expect((await scan(fixture.namespace)).storage.quarantine).toEqual({
      count: 3, bytes: 6, health: "ok", traversalEntries: 3,
    });
  });

  it("counts hard-link paths separately and physical bytes once", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const registry = lifecycleRegistryRoot(fixture.namespace, "quarantine");
    const first = path.join(registry, "first");
    await writeFile(first, "shared");
    await link(first, path.join(registry, "second"));
    expect((await scan(fixture.namespace)).storage.quarantine).toEqual({
      count: 2, bytes: 6, health: "ok", traversalEntries: 2,
    });
  });

  it("keeps nested readable foreign content storage-healthy but semantically incomplete", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const unit = path.join(
      lifecycleRegistryRoot(fixture.namespace, "quarantine"), "qtn-foreign",
    );
    const nested = path.join(unit, "portable");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "leaf"), "nested");
    const snapshot = await scan(fixture.namespace);
    expect(snapshot.storage.quarantine).toEqual({
      count: 1, bytes: 6, health: "ok", traversalEntries: 3,
    });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.units[0]?.state).toBe("unavailable");
  });

  it.each(["quarantine", "prune"] as const)(
    "counts every readable %s regular path regardless of leaf name",
    async (registryName) => {
      const fixture = await lifecycleSnapshotFixture(root.dir);
      const registry = lifecycleRegistryRoot(fixture.namespace, registryName);
      const unit = path.join(registry, registryName === "quarantine" ? "qtn-unit" : "prn-unit");
      await mkdir(unit);
      await writeFile(path.join(registry, ".hidden"), "root");
      await writeFile(path.join(unit, ".hidden"), "nested");
      const storage = (await scan(fixture.namespace)).storage[registryName];
      expect(storage).toEqual({
        count: 2, bytes: 10, health: "ok", traversalEntries: 3,
      });
      if (registryName === "quarantine") {
        expect(storage).toMatchObject(
          (await scanPreparationInventory(root.dir)).quarantine,
        );
      }
    },
  );

  it("accounts a regular bytes child before projecting its semantic role", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const registry = lifecycleRegistryRoot(fixture.namespace, "quarantine");
    await mkdir(path.join(registry, "qtn-unit"));
    await writeFile(path.join(registry, "qtn-unit", "bytes"), "readable");
    const snapshot = await scan(fixture.namespace);
    const baseline = await scanPreparationInventory(root.dir);
    expect(snapshot.storage.quarantine).toMatchObject(baseline.quarantine);
    expect(snapshot.storage.quarantine).toMatchObject({
      count: 1, bytes: 8, health: "ok",
    });
    expect(snapshot.complete).toBe(false);
  });

  it.each(["quarantine", "prune"] as const)(
    "walks a dotted lowercase %s root directory before semantic classification",
    async (registryName) => {
      const fixture = await lifecycleSnapshotFixture(root.dir);
      const registry = lifecycleRegistryRoot(fixture.namespace, registryName);
      await mkdir(path.join(registry, "bad.name"));
      await writeFile(path.join(registry, "bad.name", "leaf"), "nested");
      const snapshot = await scan(fixture.namespace);
      expect(snapshot.storage[registryName]).toEqual({
        count: 1, bytes: 6, health: "ok", traversalEntries: 2,
      });
      if (registryName === "quarantine") {
        expect(snapshot.storage.quarantine).toMatchObject(
          (await scanPreparationInventory(root.dir)).quarantine,
        );
      }
    },
  );

  it("reports exact independent quarantine and prune totals", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const quarantine = lifecycleRegistryRoot(fixture.namespace, "quarantine");
    const prune = lifecycleRegistryRoot(fixture.namespace, "prune");
    await writeFile(path.join(quarantine, "direct"), "aa");
    await mkdir(path.join(quarantine, "qtn-unit", "nested"), { recursive: true });
    await writeFile(path.join(quarantine, "qtn-unit", "nested", "leaf"), "bbb");
    await writeFile(path.join(prune, "direct"), "cccc");
    const storage = (await scan(fixture.namespace)).storage;
    expect(storage.quarantine).toEqual({
      count: 2, bytes: 5, health: "ok", traversalEntries: 4,
    });
    expect(storage.prune).toEqual({
      count: 1, bytes: 4, health: "ok", traversalEntries: 1,
    });
  });

  it("binds storage and traversal changes into the snapshot digest", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const before = await scan(fixture.namespace);
    await writeFile(path.join(lifecycleRegistryRoot(
      fixture.namespace, "prune",
    ), "direct"), "digest");
    const after = await scan(fixture.namespace);
    expect(after.storage.prune.traversalEntries).toBe(1);
    expect(after.digest).not.toBe(before.digest);
  });

  it("is monotonic for ordinary, hard-link, tmp, and writing paths in both registries", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    for (const registry of ["quarantine", "prune"] as const) {
      const values = await addMonotonicFiles(
        lifecycleRegistryRoot(fixture.namespace, registry),
        () => scan(fixture.namespace),
        registry,
      );
      expect(values.map(({ count }) => count)).toEqual([1, 2, 3, 4]);
      expect(values.map(({ bytes }) => bytes)).toEqual([4, 4, 6, 9]);
    }
  });
});
