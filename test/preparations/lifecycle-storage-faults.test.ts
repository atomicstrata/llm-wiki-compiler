/**
 * @file test/preparations/lifecycle-storage-faults.test.ts
 * @description Fail-closed physical-observation attacks for lifecycle storage.
 * Symlinks, special or unreadable leaves, nonportable directories, depth
 * exhaustion, and the shared entry bound must never produce healthy totals.
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import type { PreparationLifecycleNamespaceV1 } from "../../src/preparations/lifecycle-fs/types.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import { lifecycleRegistryRoot } from "./lifecycle-storage-test-helpers.js";
import { lifecycleSnapshotFixture } from "./lifecycle-snapshot-fixture.js";

/** Require the canonical quarantine registry created by the fixture. */
function quarantineRoot(namespace: PreparationLifecycleNamespaceV1): string {
  return lifecycleRegistryRoot(namespace, "quarantine");
}

/** Assert one fixture scan makes quarantine storage physically unavailable. */
async function expectUnavailable(namespace: PreparationLifecycleNamespaceV1): Promise<void> {
  const snapshot = await scanPreparationLifecycle(namespace);
  expect(snapshot.storage.quarantine.health).toBe("unavailable");
}

/** Return the registry root or one real prospective-unit directory below it. */
async function faultParent(registry: string, location: "direct" | "nested"): Promise<string> {
  if (location === "direct") return registry;
  const unit = path.join(registry, "qtn-unit");
  await mkdir(unit);
  return unit;
}

describe("preparation lifecycle storage faults", () => {
  const root = useTempRoot();

  it.each(["direct", "nested"] as const)("rejects a %s symlink without following it", async (
    location,
  ) => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const registry = quarantineRoot(fixture.namespace);
    const outside = path.join(root.dir, "outside");
    await writeFile(outside, "outside");
    const parent = await faultParent(registry, location);
    await symlink(outside, path.join(parent, "planted-link"));
    await expectUnavailable(fixture.namespace);
  });

  it.each(["direct", "nested"] as const)("rejects a %s special file without blocking", async (
    location,
  ) => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const registry = quarantineRoot(fixture.namespace);
    const parent = await faultParent(registry, location);
    execFileSync("mkfifo", [path.join(parent, "planted-pipe")]);
    await expectUnavailable(fixture.namespace);
  });

  it.each(["direct", "nested"] as const)("rejects a %s unreadable regular leaf", async (
    location,
  ) => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const registry = quarantineRoot(fixture.namespace);
    const parent = await faultParent(registry, location);
    const leaf = path.join(parent, "blocked");
    await writeFile(leaf, "secret");
    await chmod(leaf, 0o000);
    try {
      await expectUnavailable(fixture.namespace);
    } finally {
      await chmod(leaf, 0o600);
    }
  });

  it.each((["quarantine", "prune"] as const).flatMap((registry) =>
    (["direct", "nested"] as const).map((location) => ({ registry, location }))))(
    "rejects an uppercase $registry $location directory component",
    async ({ registry: registryName, location }) => {
      const fixture = await lifecycleSnapshotFixture(root.dir);
      const registry = lifecycleRegistryRoot(fixture.namespace, registryName);
      const parent = await faultParent(registry, location);
      await mkdir(path.join(parent, "Upper"));
      await writeFile(path.join(parent, "Upper", "leaf"), "blocked");
      const storage = (await scanPreparationLifecycle(fixture.namespace)).storage;
      expect(storage[registryName].health).toBe("unavailable");
      if (registryName === "quarantine") {
        expect(storage.quarantine).toMatchObject(
          (await scanPreparationInventory(root.dir)).quarantine,
        );
      }
    },
  );

  it("marks depth exhaustion unavailable and retains observed lower bounds", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    let nested = path.join(quarantineRoot(fixture.namespace), "qtn-deep");
    await mkdir(nested);
    for (let depth = 0; depth < 35; depth += 1) {
      nested = path.join(nested, `d${depth}`);
      await mkdir(nested);
    }
    await writeFile(path.join(nested, "leaf"), "deep");
    const storage = (await scanPreparationLifecycle(fixture.namespace)).storage.quarantine;
    expect(storage.health).toBe("unavailable");
    expect(storage.traversalEntries).toBeGreaterThan(32);
  });

  it("charges nested traversal to the scanner's existing global entry bound", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const nested = path.join(quarantineRoot(fixture.namespace), "qtn-bound", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "leaf"), "bounded");
    const snapshot = await scanPreparationLifecycle(fixture.namespace, {
      maxRegistryEntries: 2,
    });
    expect(snapshot.storage.quarantine.health).toBe("unavailable");
    expect(snapshot.storage.quarantine.traversalEntries).toBe(3);
    expect(snapshot.problems.some((problem) =>
      problem.code === "registry-entries-exhausted")).toBe(true);
  });
});
