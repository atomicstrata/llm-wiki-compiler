/**
 * @file test/preparations/lifecycle-root-enumeration.test.ts
 * @description Production-path proof that one lifecycle read enumerates each
 * exact registry root once while detecting a same-UID mutation that lands
 * during the original root enumeration.
 */

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";

const listingProbe = vi.hoisted(() => ({
  calls: [] as string[],
  mutateRoot: undefined as string | undefined,
  lateFile: undefined as string | undefined,
  mutated: false,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    opendir: async (directory: Parameters<typeof actual.opendir>[0]) => {
      const handle = await actual.opendir(directory);
      const observedPath = String(directory);
      listingProbe.calls.push(observedPath);
      if (observedPath !== listingProbe.mutateRoot || listingProbe.mutated) return handle;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const entry of handle) yield entry;
          listingProbe.mutated = true;
          await actual.writeFile(listingProbe.lateFile as string, "late");
        },
      } as typeof handle;
    },
  };
});

import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import { lifecycleSnapshotFixture } from "./lifecycle-snapshot-fixture.js";
import { lifecycleRegistryRoot } from "./lifecycle-storage-test-helpers.js";

describe("preparation lifecycle root enumeration", () => {
  const root = useTempRoot();

  it("opens each registry root once and rejects an in-enumeration mutation", async () => {
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const quarantine = lifecycleRegistryRoot(fixture.namespace, "quarantine");
    const prune = lifecycleRegistryRoot(fixture.namespace, "prune");
    listingProbe.mutateRoot = quarantine;
    listingProbe.lateFile = path.join(quarantine, "late");
    const snapshot = await scanPreparationLifecycle(fixture.namespace);
    const rootCalls = (registry: string) =>
      listingProbe.calls.filter((candidate) => candidate === registry).length;
    expect({ quarantine: rootCalls(quarantine), prune: rootCalls(prune) })
      .toEqual({ quarantine: 1, prune: 1 });
    expect(snapshot.storage.quarantine.health).toBe("unavailable");
    expect(snapshot.storage.prune.health).toBe("ok");
  });
});
