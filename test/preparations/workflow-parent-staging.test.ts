/**
 * @file test/preparations/workflow-parent-staging.test.ts
 * @description P6.2 witnesses for the UNDER-LOCK staging arbitration of a
 * parent-bound preparation (src/preparations/stage.ts): the lifecycle admission
 * (a parent-bound stage is admitted only while its parent run is running AND
 * that stage is current) and the get-or-create (a second staging under the same
 * parent tuple reuses the one attempt or parks a conflict, never mints a
 * duplicate). Both run inside `stagePreparationLocked`, so these drive it
 * directly against a real written parent run.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { writeRun } from "../../src/workflows/store.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun, type WorkflowRunStatus } from "../../src/workflows/types.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { PreparationId, PreparationRunId } from "../../src/preparations/ids.js";
import { fixturePlan, readReplayedRun, stageRequest } from "./store-fixture.js";

const root = useTempRoot();
const RUN_ID = "journey-2026-08-29-0001";
const WF_DIGEST = "ab".repeat(32);

/** Write a parent workflow run at a given status/current stage. */
async function writeParent(status: WorkflowRunStatus, currentStage: string | null): Promise<void> {
  const run: WorkflowRun = {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, runId: RUN_ID, workflowId: "research-journey",
    workflowDigest: WF_DIGEST, profileDigest: "cd".repeat(32), knownStageIds: ["ingest", "ideate"],
    status, currentStage, stageLog: [{ stageId: "ingest", status: "running" }],
    inputs: {}, outputs: {}, stateVersion: 0, startedAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    events: [{ type: "workflow-start", at: "2026-08-29T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 }],
    satisfiedGates: [],
  };
  await writeRun(root.dir, run);
}

/** A fixture plan bound to the parent run at `stageId` (optionally mutated to differ). */
function parentPlan(stageId: string, mutate: (plan: Record<string, unknown>) => void = () => {}) {
  return fixturePlan((plan) => {
    plan.workflowParent = {
      workflowRunId: RUN_ID, workflowId: "research-journey",
      workflowDigest: parseSha256Digest(`sha256:${WF_DIGEST}`), stageId,
    };
    mutate(plan);
  });
}

describe("under-lock parent admission", () => {
  it("admits a parent-bound stage while the parent is running and the stage is current", async () => {
    await writeParent("running", "ingest");
    const staged = await stagePreparationLocked(root.dir, stageRequest(parentPlan("ingest")));
    expect(staged.status).toBe("staged");
  });

  it("parks when the parent run is no longer running", async () => {
    await writeParent("completed", "ingest");
    const parked = await stagePreparationLocked(root.dir, stageRequest(parentPlan("ingest")));
    expect(parked).toEqual({ status: "parked", reason: "workflow-parent-not-running" });
  });

  it("parks when the bound stage is not the parent's current stage", async () => {
    await writeParent("running", "ideate");
    const parked = await stagePreparationLocked(root.dir, stageRequest(parentPlan("ingest")));
    expect(parked).toEqual({ status: "parked", reason: "workflow-parent-stage-not-current" });
  });
});

/** Write the running parent and stage its first `ingest`-bound attempt. */
async function firstIngestAttempt() {
  await writeParent("running", "ingest");
  const first = await stagePreparationLocked(root.dir, stageRequest(parentPlan("ingest")));
  expect(first.status, JSON.stringify(first)).toBe("staged");
  if (first.status !== "staged") throw new Error("unreachable");
  return first;
}

describe("under-lock get-or-create", () => {
  it("reuses the one existing attempt on a duplicate staging (no second preparation)", async () => {
    const first = await firstIngestAttempt();
    const second = await stagePreparationLocked(root.dir, stageRequest(parentPlan("ingest")));
    expect(second.status).toBe("staged");
    if (second.status !== "staged") throw new Error("unreachable");
    expect(second.wrote).toBe(false);
    expect(second.manifest.preparationId).toBe(first.manifest.preparationId);
  });

  it("parks an incompatible retry under the same parent tuple (different plan digest)", async () => {
    await firstIngestAttempt();
    // Same parent tuple, DIFFERENT plan: a higher control-transition allowance
    // changes the run bounds and therefore the plan digest.
    const different = parentPlan("ingest", (plan) => {
      (plan.bounds as Record<string, number>).maximumTransitions += 1;
    });
    const parked = await stagePreparationLocked(root.dir, stageRequest(different));
    expect(parked).toEqual({ status: "parked", reason: "workflow-parent-incompatible" });
  });

  // The parent-bound analogue of the fixed-id crash-replay: a first attempt
  // crashes after the manifest but before the run, leaving an incomplete pair.
  // The NEXT parent-bound staging (no pinned ids) must find that attempt via the
  // get-or-create and RECONCILE it through the same durability legs — not return
  // the incomplete manifest and strand a run product-drive can never locate.
  it("reconciles a crashed attempt (manifest, no run) on the next parent-bound staging", async () => {
    await writeParent("running", "ingest");
    const IDS = { preparationId: `prp_${"c".repeat(32)}` as PreparationId, runId: `prr_${"d".repeat(32)}` as PreparationRunId };
    const CLOCK = { now: () => new Date("2026-08-29T00:00:00.000Z") };
    await expect(stagePreparationLocked(root.dir, stageRequest(parentPlan("ingest"), {
      idsForTest: IDS, clock: CLOCK,
      faultsForTest: { beforeInitialRunSync: async () => { throw new Error("crash before run"); } },
    }))).rejects.toThrow();
    // Re-stage WITHOUT pinning ids: the get-or-create reuses the crashed attempt.
    const replay = await stagePreparationLocked(root.dir, stageRequest(parentPlan("ingest")));
    expect(replay.status).toBe("staged");
    if (replay.status !== "staged") throw new Error("unreachable");
    expect(replay.manifest.preparationId).toBe(IDS.preparationId);
    const run = await readReplayedRun(root.dir, replay.manifest, IDS);
    expect(run.status === "ok" && run.run.state).toBe("planned");
  });
});
