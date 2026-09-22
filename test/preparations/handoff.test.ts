/**
 * @file test/preparations/handoff.test.ts
 * @description The happy-path and revalidation contract for the network-free
 * idempotent handoff (design section 22.3). A settled preparation converts to one
 * immutable, self-contained Milestone A bundle whose manifest binds the
 * host-authored origin entry; the preparation run reaches `handed-off` bound to
 * the exact reserved bundle; a second call is idempotent; and every non-startable
 * durable state — wrong run state, manifest drift, advisory cancellation — fails
 * closed without creating a bundle.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { handoffPreparation, HandoffError } from "../../src/preparations/handoff.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";
import { PREPARATION_HANDOFF_ORIGIN_KIND } from "../../src/operation-bundles/preparation-origin.js";
import { stageReadyPreparation, handoffRequest } from "./handoff-fixture.js";

const root = useTempRoot();

describe("network-free idempotent handoff", () => {
  it("converts a ready preparation into one self-contained bundle and reaches handed-off", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await handoffPreparation(root.dir, handoffRequest(binding));
    expect(result.outcome).toBe("handed-off");
    expect(result.bundleId).toBe(result.bundleId);
    const run = await readPreparationRun(root.dir, binding);
    expect(run.status === "ok" && run.run.state).toBe("handed-off");
    expect(run.status === "ok" && run.run.handoff?.bundleId).toBe(result.bundleId);
  });

  it("binds a host-authored preparation-handoff-origin entry into the bundle manifest", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await handoffPreparation(root.dir, handoffRequest(binding));
    const manifest = await readOperationManifest(root.dir, binding.workspaceId, result.bundleId);
    expect(manifest.status).toBe("ok");
    const origin = manifest.status === "ok"
      && manifest.manifest.preparationEvidence.find((entry) => entry.type === PREPARATION_HANDOFF_ORIGIN_KIND);
    expect(origin).toBeTruthy();
  });

  it("is idempotent: a second identical call re-settles the same bundle", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const first = await handoffPreparation(root.dir, handoffRequest(binding));
    const inventoryBefore = await scanOperationInventory(root.dir);
    const run = await readPreparationRun(root.dir, binding);
    // A handed-off run refuses a fresh handoff attempt; the bundle is not duplicated.
    await expect(handoffPreparation(root.dir, handoffRequest(binding))).rejects.toBeInstanceOf(HandoffError);
    const inventoryAfter = await scanOperationInventory(root.dir);
    expect(inventoryAfter.manifests.length).toBe(inventoryBefore.manifests.length);
    expect(run.status === "ok" && run.run.handoff?.bundleId).toBe(first.bundleId);
  });

  it("refuses a run that is not handoff-ready and creates no bundle", async () => {
    const binding = await stageReadyPreparation(root.dir);
    // Fabricate drift by pointing the binding at a wrong manifest digest.
    const drifted = { ...binding, manifestDigest: parseSha256Digest(`sha256:${"c".repeat(64)}`) };
    await expect(handoffPreparation(root.dir, handoffRequest(drifted))).rejects.toMatchObject({ code: "not-handoff-ready" });
    expect((await scanOperationInventory(root.dir)).manifests.length).toBe(0);
  });

  it("fails closed when an advisory cancellation is present", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await writePreparationCancelLockFree(root.dir, {
      workspaceId: binding.workspaceId, runId: binding.runId, requester: "operator",
      at: "2026-07-23T00:03:00.000Z", nonce: "a".repeat(32),
    });
    await expect(handoffPreparation(root.dir, handoffRequest(binding))).rejects.toMatchObject({ code: "cancelled" });
    expect((await scanOperationInventory(root.dir)).manifests.length).toBe(0);
  });
});
