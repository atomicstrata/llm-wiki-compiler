/**
 * @file test/preparations/lifecycle-capacity-bounds.test.ts
 * @description Shared entry-ceiling regressions for split preparation capacity.
 * The active and quarantine observations retain the baseline combined budget,
 * prune remains outside that compatibility sum, and the lifecycle scanner keeps
 * its independent quarantine-plus-prune ceiling.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { MAX_PREPARATION_INVENTORY_ENTRIES } from "../../src/preparations/constants.js";
import { lifecycleScanBounds } from "../../src/preparations/lifecycle-fs/bounds.js";
import { preparationScanEntryLimit } from "../../src/preparations/orphan-scan.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { stageRequest } from "./store-fixture.js";

const TIGHT_LIMIT = 2;

/** Create two healthy active traversal entries owned by the expected topology. */
async function activeSkeleton(root: string): Promise<void> {
  await mkdir(
    path.join(root, ".llmwiki", "workspaces", "research", "preparations"),
    { recursive: true },
  );
}

/** Add one readable quarantine path and return its location. */
async function quarantineLeaf(root: string): Promise<string> {
  const registry = path.join(root, ".llmwiki", "preparation-quarantine");
  await mkdir(registry, { recursive: true });
  const leaf = path.join(registry, "foreign");
  await writeFile(leaf, "q");
  return leaf;
}

/** Write direct regular files into one physical lifecycle registry. */
async function lifecycleFiles(
  root: string,
  registryName: "preparation-quarantine" | "preparation-prune",
  names: readonly string[],
): Promise<void> {
  const registry = path.join(root, ".llmwiki", registryName);
  await mkdir(registry, { recursive: true });
  await Promise.all(names.map((name) =>
    writeFile(path.join(registry, name), name)));
}

/** Test-only stage request carrying the same monotonically tightened ceiling. */
function boundedStageRequest() {
  return stageRequest(undefined, {
    capacityOptionsForTest: { maxDirectoryEntriesForTest: TIGHT_LIMIT },
  });
}

/** Scan capacity with the suite's one shared tightened ceiling. */
async function boundedInventory(root: string) {
  return scanPreparationInventory(root, {
    maxDirectoryEntriesForTest: TIGHT_LIMIT,
  });
}

/** Whether one inventory contains the named stable problem dimension. */
function hasProblem(
  inventory: Awaited<ReturnType<typeof scanPreparationInventory>>,
  dimension: string,
): boolean {
  return inventory.problems.some((problem) => problem.dimension === dimension);
}

describe("preparation capacity entry ceiling", () => {
  const root = useTempRoot();

  it("records exhaustion when active and quarantine separately fit but their sum does not", async () => {
    await activeSkeleton(root.dir);
    await quarantineLeaf(root.dir);
    expect(hasProblem(
      await boundedInventory(root.dir), "directory-entries",
    )).toBe(true);
  });

  it("refuses the combined overflow before any staging leaf write", async () => {
    await activeSkeleton(root.dir);
    await quarantineLeaf(root.dir);
    await expect(stagePreparationLocked(root.dir, boundedStageRequest()))
      .rejects.toThrow(/directory-entries/u);
    const active = path.join(root.dir, ".llmwiki", "workspaces");
    const names = await readdir(active, { recursive: true });
    expect(names.some((name) =>
      /manifest\.json|preparation-runs|evidence/u.test(name))).toBe(false);
  });

  it("stages successfully after the combined inventory returns within the limit", async () => {
    await activeSkeleton(root.dir);
    const leaf = await quarantineLeaf(root.dir);
    await rm(leaf);
    const result = await stagePreparationLocked(root.dir, boundedStageRequest());
    expect(result.status === "staged" && result.wrote).toBe(true);
  });

  it("does not charge prune-only entries to the compatibility sum", async () => {
    await activeSkeleton(root.dir);
    await lifecycleFiles(
      root.dir, "preparation-prune", ["one", "two"],
    );
    expect(hasProblem(
      await boundedInventory(root.dir), "directory-entries",
    )).toBe(false);
  });

  it("keeps the lifecycle quarantine-plus-prune bound tightened", async () => {
    // The lifecycle scanner enforces ONE ceiling across both its registries.
    // Exhausting it is observed through quarantine, which is capacity's business:
    // prune faults deliberately no longer reach capacity at all, so asserting a
    // prune problem here would assert something capacity must not do.
    await lifecycleFiles(
      root.dir, "preparation-quarantine", ["one", "two", "three"],
    );
    expect(hasProblem(
      await boundedInventory(root.dir), "quarantine-storage",
    )).toBe(true);
  });

  it("leaves quarantine observation intact when prune exhausts the shared bound", async () => {
    // Quarantine is enumerated first, so prune can never truncate it. Without
    // this, removing prune from capacity could have hidden a real quarantine
    // under-count behind a registry that no longer reports anything.
    await lifecycleFiles(root.dir, "preparation-quarantine", ["one"]);
    await lifecycleFiles(root.dir, "preparation-prune", ["one", "two", "three"]);
    const inventory = await boundedInventory(root.dir);
    expect(inventory.quarantine.count).toBe(1);
    expect(inventory.quarantine.health).toBe("ok");
  });
});

describe("test-only entry ceilings only tighten", () => {
  // The seam is documented as monotonic, and both halves of the shared budget
  // enforce it with a host-capped minimum. Nothing exercised the RAISE
  // direction, so removing either clamp left every bound test green while a
  // test-only option could exceed the host maximum it is supposed to respect.
  const raised = MAX_PREPARATION_INVENTORY_ENTRIES + 1;

  it("caps an active-scan request above the host maximum", () => {
    expect(preparationScanEntryLimit({ maxDirectoryEntriesForTest: raised }))
      .toBe(MAX_PREPARATION_INVENTORY_ENTRIES);
  });

  it("caps a lifecycle-scan request above the host maximum", () => {
    expect(lifecycleScanBounds({ maxRegistryEntries: raised }).maxRegistryEntries)
      .toBe(MAX_PREPARATION_INVENTORY_ENTRIES);
  });

  it("still honours a request below the host maximum", () => {
    expect(preparationScanEntryLimit({ maxDirectoryEntriesForTest: TIGHT_LIMIT })).toBe(TIGHT_LIMIT);
    expect(lifecycleScanBounds({ maxRegistryEntries: TIGHT_LIMIT }).maxRegistryEntries).toBe(TIGHT_LIMIT);
  });
});
