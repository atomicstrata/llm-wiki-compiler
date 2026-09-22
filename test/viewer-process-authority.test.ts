/**
 * @file test/viewer-process-authority.test.ts
 * @description Proves both workflow viewer envelopes expose the immutable
 * process/workspace identity required to interpret a product-driven run and
 * diagnose descriptor or workspace-composition drift.
 */

import { describe, expect, it } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { writeRun } from "../src/workflows/store.js";
import { workflowStatus } from "../src/workflows/status.js";
import { buildWorkflowRunsEnvelope } from "../src/viewer/workflow-runs.js";
import { buildWorkflowRunProjection } from "../src/viewer/workflow-run-projection.js";

describe("viewer product process authority", () => {
  it("exposes process and workspace identities in list and per-run envelopes", async () => {
    const root = await makeTempRoot("viewer-process-authority");
    await installWorkflowProfile(root);
    const started = await startWorkflow(root, "build", {});
    const authority = {
      schemaVersion: 1 as const, productId: "com.example.editorial",
      processDefinitionDigest: `sha256:${"1".repeat(64)}`,
      runtimeAuthorityDigest: `sha256:${"2".repeat(64)}`,
      workspaceId: "desk-one", workspaceCompositionDigest: `sha256:${"3".repeat(64)}`,
    };
    const run = { ...started, processAuthority: authority };
    await writeRun(root, run);
    const expected = {
      productId: authority.productId,
      processDefinitionDigest: authority.processDefinitionDigest,
      runtimeAuthorityDigest: authority.runtimeAuthorityDigest,
      workspaceId: authority.workspaceId,
      workspaceCompositionDigest: authority.workspaceCompositionDigest,
    };
    const detail = await buildWorkflowRunProjection(root, run.workflowId, run.runId);
    if ("problem" in detail) throw new Error(detail.problem);
    expect(detail).toMatchObject(expected);
    const row = buildWorkflowRunsEnvelope(await workflowStatus(root)).runs
      .find((candidate) => candidate.runId === run.runId);
    expect(row).toMatchObject(expected);
  });
});
