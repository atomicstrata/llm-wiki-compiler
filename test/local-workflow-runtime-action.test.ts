/**
 * @file test/local-workflow-runtime-action.test.ts
 * @description Constructed action dispatch uses supplied authority and run
 * services while retaining the existing surface and interactive gate refusals.
 */
import { describe, expect, it, vi } from "vitest";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";
import { ActionDeniedError } from "../src/workflows/errors.js";

const ctx = useConfinementRoots("constructed-action");

describe("constructed action dispatch", () => {
  it("uses host grants and writes for start and preserves scoped status", async () => {
    await installRunActionProfile(ctx.root);
    const base = createLocalWorkflowHost();
    const localGrant = vi.fn(base.authority.localGrant);
    const write = vi.fn(base.records.write);
    const statusForWorkflow = vi.fn(base.history.statusForWorkflow);
    const runtime = createLocalWorkflowRuntime({ ...base,
      authority: { ...base.authority, localGrant }, records: { ...base.records, write },
      history: { ...base.history, statusForWorkflow } });
    expect(await runtime.runAction(ctx.root, "build.start", {}, "sdk"))
      .toMatchObject({ operation: "start", effectivePermission: "trusted-write", result: { status: "pending" } });
    await runtime.runAction(ctx.root, "build.status", {}, "sdk");
    expect(localGrant).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(statusForWorkflow).toHaveBeenCalledWith(ctx.root, "build");
  });

  it("refuses programmatic human approval before terminal proof or mutation", async () => {
    await installRunActionProfile(ctx.root);
    const base = createLocalWorkflowHost();
    const confirmHumanGate = vi.fn(base.terminal.confirmHumanGate);
    const write = vi.fn(base.records.write);
    const runtime = createLocalWorkflowRuntime({ ...base,
      terminal: { ...base.terminal, confirmHumanGate }, records: { ...base.records, write } });
    await expect(runtime.runAction(ctx.root, "gatehuman.approve", { runId: "absent" }, "mcp"))
      .rejects.toBeInstanceOf(ActionDeniedError);
    expect(confirmHumanGate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
