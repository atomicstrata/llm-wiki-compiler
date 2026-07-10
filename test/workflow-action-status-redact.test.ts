/**
 * @file test/workflow-action-status-redact.test.ts
 * @description Regression (HIGH leak): a workflow-SCOPED `status` action must not
 * leak ANOTHER workflow's run identity through a per-run problem row.
 *
 * A corrupt individual run is `run === undefined` with the REAL runId + a
 * `problem` — indistinguishable from the run's workflow, so its id is UNSCOPABLE
 * to the action's workflow. `build.status` must therefore REDACT such per-run
 * problems to ONE id-free aggregate health row (fail-visible, exits nonzero) and
 * NEVER print the out-of-scope `secret-...` run id or its `corrupt` detail. The
 * store-wide `(store)` health row is still preserved globally (the prior fix), and
 * the UNSCOPED `workflow status` still shows the full per-run diagnostics.
 */

import { describe, it, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runAction } from "../src/workflows/run-action.js";
import { workflowStatus } from "../src/workflows/status.js";
import { startWorkflow } from "../src/workflows/start.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import type { RunStatus } from "../src/workflows/status.js";

const ctx = useConfinementRoots("wf-action-redact");

/** Overwrite a run's on-disk JSON with invalid bytes so `readRun` reports `corrupt`. */
async function corruptRun(root: string, runId: string): Promise<void> {
  const leaf = path.join(root, LLMWIKI_DIR, "workflows", "runs", `${runId}.json`);
  await writeFile(leaf, "{ not valid json", "utf8");
}

/** Run `build.status` (cli) and return both the typed rows and their serialized form. */
async function buildStatus(root: string): Promise<{ rows: RunStatus[]; json: string }> {
  const rows = (await runAction(root, "build.status", {}, "cli")).result as RunStatus[];
  return { rows, json: JSON.stringify(rows) };
}

describe("status action — redacts unscopable out-of-scope per-run problems", () => {
  it("a corrupt SECRET run is fail-visible but its id/detail NEVER leak through build.status", async () => {
    await installRunActionProfile(ctx.root);
    await startWorkflow(ctx.root, "build", {});
    const secret = await startWorkflow(ctx.root, "secret", {});
    await corruptRun(ctx.root, secret.runId);
    const { rows, json } = await buildStatus(ctx.root);
    expect(json).not.toContain(secret.runId); // no out-of-scope id leak
    expect(json).not.toContain("corrupt"); // no per-run detail leak
    expect(rows.some((r) => r.runId === "(unreadable)" && r.problem !== undefined)).toBe(true);
  });

  it("the redacted aggregate is fail-visible: build.status exits nonzero via classification", async () => {
    await installRunActionProfile(ctx.root);
    const secret = await startWorkflow(ctx.root, "secret", {});
    await corruptRun(ctx.root, secret.runId);
    const { rows } = await buildStatus(ctx.root);
    const aggregate = rows.find((r) => r.runId === "(unreadable)");
    expect(aggregate?.classification).toBe("blocked-by-config");
  });

  it("the aggregate message is COUNT-FREE: states one-or-more, never a number", async () => {
    await installRunActionProfile(ctx.root);
    await startWorkflow(ctx.root, "build", {});
    for (const _ of [0, 1, 2]) {
      const r = await startWorkflow(ctx.root, "secret", {});
      await corruptRun(ctx.root, r.runId);
    }
    const { rows } = await buildStatus(ctx.root);
    const aggregate = rows.find((r) => r.runId === "(unreadable)");
    expect(aggregate?.problem).toBe(
      "one or more run records could not be read (ids hidden; run `llmwiki workflow status` for diagnostics)",
    );
    expect(aggregate?.problem).not.toMatch(/\d/); // no count number leaks
  });

  it("a corrupt run of the action's OWN workflow is ALSO redacted (can't attribute it)", async () => {
    await installRunActionProfile(ctx.root);
    const ownBuild = await startWorkflow(ctx.root, "build", {});
    await corruptRun(ctx.root, ownBuild.runId);
    const { rows, json } = await buildStatus(ctx.root);
    expect(json).not.toContain(ownBuild.runId);
    expect(rows.some((r) => r.runId === "(unreadable)")).toBe(true);
  });

  it("UNSCOPED workflow status STILL shows the full per-run id + detail (diagnostics intact)", async () => {
    await installRunActionProfile(ctx.root);
    const secret = await startWorkflow(ctx.root, "secret", {});
    await corruptRun(ctx.root, secret.runId);
    const rows = await workflowStatus(ctx.root);
    expect(rows.some((r) => r.runId === secret.runId && r.problem === "corrupt")).toBe(true);
  });

  it("a readable in-scope build run is still shown alongside the redacted aggregate", async () => {
    await installRunActionProfile(ctx.root);
    const build = await startWorkflow(ctx.root, "build", {});
    const secret = await startWorkflow(ctx.root, "secret", {});
    await corruptRun(ctx.root, secret.runId);
    const { rows } = await buildStatus(ctx.root);
    expect(rows.some((r) => r.runId === build.runId && r.run?.workflowId === "build")).toBe(true);
  });
});
