/** Physical lifecycle-store faults and fresh-epoch witnesses shared across projection tests. */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import { stageRequest } from "./store-fixture.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";

/** Plant an external regular leaf behind a symlink inside an existing registry. */
export async function plantRegistrySymlink(root: string, registry: string): Promise<void> {
  const outside = path.join(root, "outside");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(registry, "planted"));
}

/** Observe a planted quarantine fault through the real capacity scanner. */
export async function inventoryWithQuarantineFault(root: string, registry: string) {
  await plantRegistrySymlink(root, registry);
  const inventory = await scanPreparationInventory(root);
  expect(inventory.problems.some((problem) => problem.dimension === "quarantine-storage")).toBe(true);
  return inventory;
}

/** Redirect the entire namespace, as distinct from a fault within one registry. */
export async function redirectLlmwiki(root: string): Promise<void> {
  const decoy = path.join(root, "llmwiki-decoy");
  await mkdir(decoy, { recursive: true });
  await symlink(decoy, path.join(root, ".llmwiki"));
}

/** Prove staging can mint a healthy new key despite a capacity-irrelevant prune fault. */
export async function expectFreshKeyStaging(root: string): Promise<void> {
  expect((await readPreparationKey(root)).status).not.toBe("ok");
  expect((await stagePreparationLocked(root, stageRequest())).status).toBe("staged");
  expect((await readPreparationKey(root)).status).toBe("ok");
}

/** Alter a receipt between classification and storage observation without a classifier problem. */
export async function scanWithReceiptRace(namespace: Parameters<typeof scanPreparationLifecycle>[0], receipt: string) {
  const snapshot = await scanPreparationLifecycle(namespace, {
    afterClassificationForTest: async () => { await writeFile(receipt, "x".repeat(9999)); },
  });
  expect(snapshot.problems).toEqual([]);
  return snapshot;
}
