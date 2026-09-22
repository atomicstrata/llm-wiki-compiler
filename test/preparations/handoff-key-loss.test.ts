/**
 * @file test/preparations/handoff-key-loss.test.ts
 * @description Honest fail-closed behavior when the preparation integrity key is
 * unavailable (design section 22.5). A handoff under a missing key fails closed
 * and creates nothing. After a bundle exists, the immutable Milestone A bundle is
 * self-contained and stays reviewable with its origin provenance even when the
 * preparation key is later lost; a mid-handoff key loss cannot be settled by the
 * recovery gate, which blocks honestly rather than trusting an unreadable run.
 */

import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import { preparationKeyFile } from "../../src/preparations/paths.js";
import { acquireMutationLock } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { PREPARATION_HANDOFF_ORIGIN_KIND } from "../../src/operation-bundles/preparation-origin.js";
import { stageReadyPreparation, handoffRequest, CRASH_AFTER_STAGE as crashAfterStage } from "./handoff-fixture.js";

const root = useTempRoot();

describe("handoff under preparation key loss fails closed honestly", () => {
  it("refuses a handoff when the preparation key is missing and creates nothing", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await rm(preparationKeyFile(root.dir));
    await expect(handoffPreparation(root.dir, handoffRequest(binding))).rejects.toMatchObject({ code: "key-unavailable" });
    expect((await scanOperationInventory(root.dir)).manifests.length).toBe(0);
  });

  it("keeps an exact bundle reviewable with origin provenance after key loss", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await handoffPreparation(root.dir, handoffRequest(binding));
    await rm(preparationKeyFile(root.dir));
    const manifest = await readOperationManifest(root.dir, binding.workspaceId, result.bundleId);
    expect(manifest.status).toBe("ok");
    expect(manifest.status === "ok" && manifest.manifest.preparationEvidence.some(
      (entry) => entry.type === PREPARATION_HANDOFF_ORIGIN_KIND)).toBe(true);
  });

  it("preserves the bundle and cannot settle the handoff when the key is lost mid-handoff", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: crashAfterStage }))).rejects.toThrow("crash");
    const bundleId = (await scanOperationInventory(root.dir)).manifests[0]!.bundleId;
    await rm(preparationKeyFile(root.dir));
    // The immutable bundle carries its own review authority independent of the key.
    expect((await readOperationManifest(root.dir, binding.workspaceId, bundleId)).status).toBe("ok");
    // An unrelated mutation is not blocked, but the unreadable handoff cannot be settled.
    expect(await acquireMutationLock(root.dir, "ordinary")).toBe(true);
    await releaseLock(root.dir);
    expect((await readPreparationRun(root.dir, binding)).status).toBe("unavailable");
  });
});
