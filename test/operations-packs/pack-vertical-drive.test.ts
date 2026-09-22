/**
 * @file test/operations-packs/pack-vertical-drive.test.ts
 * @description THE INTEGRATION PROOF for WOP V3 slice 3C: one pack action
 * compiled, staged, driven, materialized, and handed off, through the production
 * constructors only. Every earlier slice could be green while the vertical
 * stranded — 3A's registry settled every host-handler phase `failed`, which makes
 * `handed-off` unreachable — so the claim this file exists to make is not "the
 * pieces have tests" but "the pieces reach a Milestone A bundle together".
 *
 * Nothing here comes from a `test/preparations` journey fixture: the plan is the
 * compiler's own output, the legs are the executable registry's, the obligation
 * is the pack materializer's, and the adapters are the host's real seven.
 */

import { afterEach, describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import {
  createPackMaterializer, PackMaterializationError,
} from "../../src/operations-packs/runtime/materializer.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import type { RunPreparationResultV1 } from "../../src/preparations/runner.js";
import {
  driveStagedRun, resultReason, stagedRunTracker, type StagedPackRunV1,
} from "./runtime-fixture.js";

const runs = stagedRunTracker();

afterEach(() => runs.cleanupAll());

/** Compile, stage, and drive one pack action to its terminal runner outcome. */
async function drive(): Promise<{ run: StagedPackRunV1; result: RunPreparationResultV1 }> {
  const run = await runs.stage();
  return { run, result: await driveStagedRun(run) };
}

/** The authenticated durable run record for one staged preparation. */
async function durableRun(run: StagedPackRunV1): Promise<PreparationRunV1> {
  const read = await readPreparationRun(run.root, run.binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run;
}

/** Drive to handoff, requiring the terminal outcome, and read the durable run back. */
async function driveToHandoff(): Promise<{
  run: StagedPackRunV1; result: RunPreparationResultV1; durable: PreparationRunV1;
}> {
  const { run, result } = await drive();
  expect(result.status, resultReason(result)).toBe("handed-off");
  return { run, result, durable: await durableRun(run) };
}

describe("pack vertical: compile -> stage -> drive -> hand off", () => {
  it("reaches handed-off with a real bundle manifest digest", async () => {
    const { result } = await drive();

    expect(result.status, resultReason(result)).toBe("handed-off");
    expect("bundleManifestDigest" in result && result.bundleManifestDigest)
      .toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("settled the intent phase by EXECUTING it, publishing its drafts as evidence", async () => {
    const { durable } = await driveToHandoff();

    const phase = durable.phaseSummaries.find((entry) => entry.logicalPhaseId === "propose");
    // 3A's placeholder settled this `failed` with `host-handler-runtime-unavailable`.
    expect(phase?.state).toBe("succeeded");
    expect(phase?.outputEvidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(durable.evidenceRefs.some((ref) => ref.kind === "host-output")).toBe(true);
  });

  it("creates exactly one problem-free Milestone A bundle in the project", async () => {
    const { run } = await driveToHandoff();

    const inventory = await scanOperationInventory(run.root);
    expect(inventory.problems).toHaveLength(0);
    expect(inventory.completeBundleIds.size).toBe(1);
  });

  it("REFUSES rather than invents an obligation when no drafts were published", async () => {
    // A staged-but-undriven run settled no phase, so there is no terminal draft
    // evidence to derive from. This is the negative half of the proof above: the
    // materializer's obligation exists BECAUSE the run produced one, and it throws
    // instead of manufacturing a bundle when it did not.
    const run = await runs.stage();
    const durable = await durableRun(run);

    expect(() => createPackMaterializer(run.action).materialize({ run: durable, evidence: new Map() }))
      .toThrow(PackMaterializationError);
  });

  it("records the handoff on the durable run, not just in the returned result", async () => {
    const { result, durable } = await driveToHandoff();

    expect(durable.state).toBe("handed-off");
    expect(durable.handoff?.bundleManifestDigest)
      .toBe("bundleManifestDigest" in result ? result.bundleManifestDigest : undefined);
  });
});
