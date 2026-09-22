/**
 * @file test/preparations/handoff-capacity.test.ts
 * @description Downstream Milestone A cap and self-containment contract for the
 * handoff (design sections 22.1/22.3). Exact caps and current headroom are
 * verified through a zero-write dry-run BEFORE any durable boundary is crossed, so
 * an over-cap bundle payload is refused with no bundle created and the run left in
 * `handoff-ready`. A fitting bundle copies exactly the mutation payloads plus the
 * host-authored origin blob, so it is self-contained by construction.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { MAX_PAYLOAD_BYTES } from "../../src/operation-bundles/constants.js";
import { stageReadyPreparation, handoffRequest, handoffRequestOversize } from "./handoff-fixture.js";

const root = useTempRoot();

describe("handoff verifies downstream caps before any durable boundary", () => {
  it("refuses an over-cap bundle payload and creates no bundle, leaving the run ready", async () => {
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequestOversize(binding, MAX_PAYLOAD_BYTES + 1))).rejects.toThrow();
    expect((await scanOperationInventory(root.dir)).manifests.length).toBe(0);
    const run = await readPreparationRun(root.dir, binding);
    expect(run.status === "ok" && run.run.state).toBe("handoff-ready");
  });

  it("hands off a bundle whose payload sits within the cap", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await handoffPreparation(root.dir, handoffRequestOversize(binding, 4096));
    expect(result.outcome).toBe("handed-off");
  });

  it("copies exactly the mutation payloads plus the origin blob", async () => {
    const binding = await stageReadyPreparation(root.dir);
    const result = await handoffPreparation(root.dir, handoffRequest(binding));
    const manifest = await readOperationManifest(root.dir, binding.workspaceId, result.bundleId);
    if (manifest.status !== "ok") throw new Error("manifest unreadable");
    const claims = new Set([
      ...manifest.manifest.mutations.flatMap((mutation) => "payloadRef" in mutation ? [mutation.payloadRef] : []),
      ...manifest.manifest.preparationEvidence.flatMap((evidence) => evidence.payloadRef ? [evidence.payloadRef] : []),
    ]);
    expect(claims.size).toBe(2);
  });
});
