/**
 * @file test/sdk/workflow-submit-sdk.test.ts
 * @description In-process test for the EXPERIMENTAL `createWiki().submitStageOutput`
 * method.
 *
 * Over a `build` workflow whose single stage declares `writes:["experiments"]`
 * under a `trust:high` gate: start → advance (parks awaiting-output) → submit an
 * in-scope page output, which composes `allow`, lands the write live, and reports
 * `applied:true`. Also surfaces `awaitingOutput` via `workflowStatus`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useWorkflowRoot, startBuildRun } from "../fixtures/workflow-profile.js";
import { TRUSTED_WRITE_ENV_VAR } from "../../src/workflows/trusted-write.js";

const ctx = useWorkflowRoot("sdk-workflow-submit-", [
  { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" },
]);

describe("createWiki workflow submit slice (experimental)", () => {
  // The apply path of a `trust:`-gated stage requires the operator's out-of-band
  // trusted-write grant (C3) for the fixture project (profileId "research").
  beforeEach(() => {
    process.env[TRUSTED_WRITE_ENV_VAR] = "research";
  });
  afterEach(() => {
    delete process.env[TRUSTED_WRITE_ENV_VAR];
  });

  it("parks awaiting-output then applies an in-scope page output live", async () => {
    const { wiki, runId } = await startBuildRun(ctx.root);
    expect((await wiki.advanceWorkflow(runId)).outcome).toBe("awaiting-output");

    const [status] = await wiki.workflowStatus(runId);
    expect(status.awaitingOutput).toBe(true);

    const result = await wiki.submitStageOutput(runId, {
      kind: "page",
      entityType: "experiments",
      slug: "alpha",
      body: "---\ntitle: alpha\n---\nbody",
    });
    expect(result.applied).toBe(true);
    expect(result.decision).toBe("allow");
  });
});
