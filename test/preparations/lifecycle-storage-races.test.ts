/**
 * @file test/preparations/lifecycle-storage-races.test.ts
 * @description Production-scanner race regressions for physical lifecycle
 * storage. Every registry directory inventory and opened regular leaf must be
 * re-proved after classification before healthy totals can be published.
 */

import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import type {
  PreparationLifecycleNamespaceV1,
} from "../../src/preparations/lifecycle-fs/types.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import { lifecycleSnapshotFixture } from "./lifecycle-snapshot-fixture.js";
import { lifecycleRegistryRoot } from "./lifecycle-storage-test-helpers.js";

type Registry = "quarantine" | "prune";
type Location = "root" | "nested";

const REGISTRY_LOCATIONS = (["quarantine", "prune"] as const).flatMap((registry) =>
  (["root", "nested"] as const).map((location) => ({ registry, location })));
const INVENTORY_RACES = REGISTRY_LOCATIONS.flatMap(({ registry, location }) =>
  (["add", "remove"] as const).map((change) => ({ registry, location, change })));

/** Create and return a direct or nested regular-leaf path for one registry. */
async function racedLeaf(
  namespace: PreparationLifecycleNamespaceV1,
  registry: Registry,
  location: Location,
): Promise<string> {
  const root = lifecycleRegistryRoot(namespace, registry);
  const parent = location === "root"
    ? root
    : path.join(root, registry === "quarantine" ? "qtn-race" : "prn-race", "nested");
  await mkdir(parent, { recursive: true });
  return path.join(parent, "victim");
}

describe("preparation lifecycle physical storage races", () => {
  const root = useTempRoot();

  it.each(INVENTORY_RACES)(
    "marks $registry $location inventory $change unavailable",
    async ({ registry, location, change }) => {
      const fixture = await lifecycleSnapshotFixture(root.dir);
      const leaf = await racedLeaf(fixture.namespace, registry, location);
      if (change === "remove") await writeFile(leaf, "before");
      const snapshot = await scanPreparationLifecycle(fixture.namespace, {
        afterClassificationForTest: async () => {
          if (change === "add") await writeFile(leaf, "after");
          else await rm(leaf);
        },
      });
      expect(snapshot.storage[registry].health).toBe("unavailable");
    },
  );

  it.each(REGISTRY_LOCATIONS)(
    "rejects $registry $location same-name replacement with an external symlink",
    async ({ registry, location }) => {
      const fixture = await lifecycleSnapshotFixture(root.dir);
      const leaf = await racedLeaf(fixture.namespace, registry, location);
      const outside = path.join(root.dir, `${registry}-${location}-outside`);
      await writeFile(leaf, "inside");
      await writeFile(outside, "outside");
      const snapshot = await scanPreparationLifecycle(fixture.namespace, {
        afterClassificationForTest: async () => {
          await rm(leaf);
          await symlink(outside, leaf);
        },
      });
      expect(snapshot.storage[registry].health).toBe("unavailable");
    },
  );

  it.each(REGISTRY_LOCATIONS)(
    "rejects $registry $location in-place size changes",
    async ({ registry, location }) => {
      const fixture = await lifecycleSnapshotFixture(root.dir);
      const leaf = await racedLeaf(fixture.namespace, registry, location);
      await writeFile(leaf, "one");
      const before = await stat(leaf);
      const snapshot = await scanPreparationLifecycle(fixture.namespace, {
        afterClassificationForTest: async () => { await writeFile(leaf, "much-longer"); },
      });
      const after = await stat(leaf);
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(snapshot.storage[registry].health).toBe("unavailable");
    },
  );
});
