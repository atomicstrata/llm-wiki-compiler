/** Legacy gate actions preserve inactive-run and non-interactive error precedence. */
import { describe, expect, it, vi, afterEach } from "vitest";
import { runAction } from "../src/workflows/run-action.js";
import { startWorkflow } from "../src/workflows/start.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { useWorkflowRoot, ADAPT_BUILD_STAGES } from "./fixtures/workflow-profile.js";

const ctx = useWorkflowRoot("gate-error-parity-", ADAPT_BUILD_STAGES);
afterEach(() => vi.unstubAllEnvs());

describe("gate action public errors", () => {
  it("keeps the agent gate inactive-run error", async () => {
    await installRunActionProfile(ctx.root);
    const run = await startWorkflow(ctx.root, "agentwf", {});
    await cancelWorkflow(ctx.root, run.runId);
    await expect(runAction(ctx.root, "gateagent.check", { runId: run.runId }, "cli"))
      .rejects.toMatchObject({ name: "RunNotActiveError" });
  });

  it("denies a non-interactive human gate before resolving its challenge", async () => {
    await installRunActionProfile(ctx.root);
    vi.stubEnv("LLMWIKI_ENABLED_HUMAN_GATES", "human:approve");
    const run = await startWorkflow(ctx.root, "humanwf", {});
    await cancelWorkflow(ctx.root, run.runId);
    await expect(runAction(ctx.root, "gatehuman.approve", { runId: run.runId }, "cli"))
      .rejects.toMatchObject({ name: "ActionDeniedError", message: expect.stringContaining("human gate not interactively confirmed") });
  });
});
