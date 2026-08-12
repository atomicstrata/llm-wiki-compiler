/**
 * `/api/workflow-runs` must carry the classifier's PARK HINTS, not just its
 * park FLAGS.
 *
 * `RunStatus` sets `awaitingTrustGate`, `nextSubmitEntityType` and
 * `nextSubmitArtifactType` so a renderer can name a command that works. A
 * projection that keeps `awaitingGate`/`awaitingOutput` and drops those three
 * leaves the viewer able to say a run is parked but not what unparks it — and
 * the commands it then prints FAIL: `workflow submit` without `--kind` is
 * rejected by `buildStageOutput` before anything else runs, and `gate approve`
 * on a `trust:` gate is refused by `vouchGate` with `TrustGateNotHereError`.
 *
 * These tests pin the three fields onto the wire row. The rendering half of the
 * contract lives in `viewer-workflows-route.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { buildWorkflowRunsEnvelope, type WorkflowRunRow } from "../src/viewer/workflow-runs.js";
import type { RunStatus } from "../src/workflows/status.js";
import type { WorkflowRun } from "../src/workflows/types.js";

/** A 64-hex placeholder digest — the projection never reads or re-derives it. */
const PLACEHOLDER_DIGEST = "a".repeat(64);

/** A readable, non-terminal run record: enough for the projection, nothing more. */
const RUN: WorkflowRun = {
  schemaVersion: 2,
  runId: "run-0001",
  workflowId: "story-pipeline",
  workflowDigest: PLACEHOLDER_DIGEST,
  profileDigest: PLACEHOLDER_DIGEST,
  knownStageIds: ["draft-article"],
  status: "running",
  currentStage: "draft-article",
  stageLog: [{ stageId: "draft-article", status: "awaiting-gate" }],
  events: [],
  satisfiedGates: [],
  inputs: {},
  outputs: {},
  stateVersion: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Project one status and return its single row. */
function rowFor(status: Partial<RunStatus>): WorkflowRunRow {
  const full: RunStatus = { runId: "run-0001", classification: "current", run: RUN, ...status };
  return buildWorkflowRunsEnvelope([full]).runs[0];
}

describe("/api/workflow-runs — the submit hints a parked stage declares", () => {
  it("carries the declared write entity type of an output-parked stage", () => {
    const row = rowFor({ awaitingOutput: true, nextSubmitEntityType: "articles" });
    expect(row.awaitingOutput).toBe(true);
    expect(row.nextSubmitEntityType).toBe("articles");
  });

  it("carries the declared artifact type independently of the entity type", () => {
    const row = rowFor({ awaitingOutput: true, nextSubmitArtifactType: "result" });
    expect(row.nextSubmitArtifactType).toBe("result");
    expect(row.nextSubmitEntityType).toBeUndefined();
  });

  it("carries both when a stage declares a write and an artifact write", () => {
    const row = rowFor({
      awaitingOutput: true,
      nextSubmitEntityType: "articles",
      nextSubmitArtifactType: "result",
    });
    expect(row.nextSubmitEntityType).toBe("articles");
    expect(row.nextSubmitArtifactType).toBe("result");
  });

  it("omits both keys for a run that is not output-parked", () => {
    const row = rowFor({ awaitingGate: "edited" });
    expect(row).not.toHaveProperty("nextSubmitEntityType");
    expect(row).not.toHaveProperty("nextSubmitArtifactType");
  });
});

describe("/api/workflow-runs — a trust gate is distinguishable from an approvable one", () => {
  it("carries awaitingTrustGate alongside the gate id", () => {
    const row = rowFor({ awaitingGate: "trusted-write", awaitingTrustGate: true });
    expect(row.awaitingGate).toBe("trusted-write");
    expect(row.awaitingTrustGate).toBe(true);
  });

  it("omits the key for a human/agent gate, which `gate approve` does clear", () => {
    const row = rowFor({ awaitingGate: "edited" });
    expect(row.awaitingGate).toBe("edited");
    expect(row).not.toHaveProperty("awaitingTrustGate");
  });
});

describe("/api/workflow-runs — the projection stays status-only", () => {
  it("adds no field beyond the documented row shape", () => {
    const row = rowFor({
      awaitingGate: "trusted-write",
      awaitingTrustGate: true,
      awaitingOutput: true,
      nextSubmitEntityType: "articles",
      nextSubmitArtifactType: "result",
    });
    expect(Object.keys(row).sort()).toEqual([
      "awaitingGate",
      "awaitingOutput",
      "awaitingTrustGate",
      "classification",
      "currentStage",
      "nextSubmitArtifactType",
      "nextSubmitEntityType",
      "runId",
      "status",
      "workflow",
    ]);
  });

  it("never echoes the raw run record or a store-level marker", () => {
    const row = rowFor({ storeLevel: true, awaitingOutput: true, nextSubmitEntityType: "articles" });
    expect(row).not.toHaveProperty("run");
    expect(row).not.toHaveProperty("storeLevel");
  });
});
