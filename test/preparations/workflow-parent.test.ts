/**
 * @file test/preparations/workflow-parent.test.ts
 * @description One-way verified workflow-parent reference contract: a matching
 * run verifies, a missing run is absent, a corrupt run is unreadable (park, not
 * deny), and a workflow-id, digest, or stage drift is reported distinctly. No
 * path re-executes or mutates the parent.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { writeRun } from "../../src/workflows/store.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "../../src/workflows/types.js";
import { verifyWorkflowParent } from "../../src/preparations/workflow-parent.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { WorkflowParentRefV1 } from "../../src/preparations/types.js";

const root = useTempRoot();
const RUN_ID = "build-2026-07-20-1111";
const DIGEST = "ab".repeat(32);

/** Build a minimal healthy workflow run for the parent reference. */
function sampleRun(): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, runId: RUN_ID, workflowId: "build",
    workflowDigest: DIGEST, profileDigest: "cd".repeat(32), knownStageIds: ["draft", "review"],
    status: "pending", currentStage: "draft", stageLog: [{ stageId: "draft", status: "pending" }],
    inputs: {}, outputs: {}, stateVersion: 0, startedAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    events: [{ type: "workflow-start", at: "2026-07-20T00:00:00.000Z", actorKind: "system", stateVersionBefore: 0, stateVersionAfter: 0 }],
    satisfiedGates: [],
  };
}

/** Build a reference to the sample run with optional field overrides. */
function ref(overrides: Partial<WorkflowParentRefV1> = {}): WorkflowParentRefV1 {
  return { workflowRunId: RUN_ID, workflowId: "build", workflowDigest: parseSha256Digest(`sha256:${DIGEST}`), stageId: "draft", ...overrides };
}

describe("verifyWorkflowParent", () => {
  it("verifies a matching workflow run and stage", async () => {
    await writeRun(root.dir, sampleRun());
    await expect(verifyWorkflowParent(root.dir, ref())).resolves.toMatchObject({ status: "verified", workflowId: "build", stageId: "draft" });
  });

  it("reports an absent parent run", async () => {
    await expect(verifyWorkflowParent(root.dir, ref())).resolves.toEqual({ status: "absent" });
  });

  it("parks on an unreadable (corrupt) parent run without re-execution", async () => {
    const dir = path.join(root.dir, ".llmwiki", "workflows", "runs");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${RUN_ID}.json`), "{ not json", "utf8");
    const result = await verifyWorkflowParent(root.dir, ref());
    expect(result.status).toBe("unreadable");
  });

  it("reports workflow-id, digest, and stage drift distinctly", async () => {
    await writeRun(root.dir, sampleRun());
    await expect(verifyWorkflowParent(root.dir, ref({ workflowId: "other" }))).resolves.toEqual({ status: "drift", detail: "workflow-id" });
    await expect(verifyWorkflowParent(root.dir, ref({ workflowDigest: parseSha256Digest(`sha256:${"ff".repeat(32)}`) }))).resolves.toEqual({ status: "drift", detail: "digest" });
    await expect(verifyWorkflowParent(root.dir, ref({ stageId: "missing" }))).resolves.toEqual({ status: "drift", detail: "stage" });
  });

  // The verified outcome CARRIES the parent's live lifecycle so the staging
  // admission can require a running parent whose current stage matches — this
  // identity check stays lenient (a `pending` run still verifies its identity).
  it("carries the parent's runStatus and currentStage on a verified match", async () => {
    await writeRun(root.dir, { ...sampleRun(), status: "running", currentStage: "review" });
    await expect(verifyWorkflowParent(root.dir, ref({ stageId: "review" }))).resolves.toMatchObject({
      status: "verified", runStatus: "running", currentStage: "review",
    });
  });
});
