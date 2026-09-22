/**
 * @file test/local-workflow-runtime-lifecycle.test.ts
 * @description Constructed lifecycle parity over real signed records. Spies on
 * host capabilities prove lifecycle operations do not bypass supplied services.
 */
import { describe, expect, it, vi } from "vitest";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { installWorkflowProfile, buildWorkflowProfile, ADAPT_BUILD_STAGES, ADAPT_RENAMED_STAGES } from "./fixtures/workflow-profile.js";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";
import { RunNotActiveError } from "../src/workflows/errors.js";

const ctx = useConfinementRoots("constructed-lifecycle");

describe("constructed lifecycle operations", () => {
  it("resolves and approves an agent gate through the host without duplicate approval writes", async () => {
    const stages = [{ id: "review", reads: [], writes: [], gate: "agent:review" }];
    await installWorkflowProfile(ctx.root, buildWorkflowProfile(stages));
    const base = createLocalWorkflowHost();
    const write = vi.fn(base.records.write);
    const runtime = createLocalWorkflowRuntime({ ...base, records: { ...base.records, write } });
    const started = await runtime.start({ root: ctx.root, workflowId: "build", inputs: {} });
    expect(await runtime.gateChallenge(ctx.root, started.runId, "review")).toEqual({ kind: "agent" });
    const approved = await runtime.approveGate(ctx.root, started.runId, "review", { actorKind: "agent" });
    expect(approved.satisfiedGates).toEqual(["agent:review"]);
    await runtime.approveGate(ctx.root, started.runId, "review", { actorKind: "agent" });
    expect(write).toHaveBeenCalledTimes(2);
    expect((await runtime.advance(ctx.root, started.runId)).outcome).toBe("completed");
  });

  it("previews without a write and applies a lossless stage rename through the host", async () => {
    await installWorkflowProfile(ctx.root, buildWorkflowProfile(ADAPT_BUILD_STAGES));
    const base = createLocalWorkflowHost();
    const write = vi.fn(base.records.write);
    const runtime = createLocalWorkflowRuntime({ ...base, records: { ...base.records, write } });
    const run = await runtime.start({ root: ctx.root, workflowId: "build", inputs: {} });
    await installWorkflowProfile(ctx.root, buildWorkflowProfile(ADAPT_RENAMED_STAGES));
    const before = await base.history.read(ctx.root, run.runId);
    const plans = await runtime.adaptDryRun(ctx.root, run.runId);
    expect(plans).toMatchObject([{ lossless: true, stageMapping: [{ from: "draft", to: "compose" }, { from: "run", to: "run" }] }]);
    expect(write).toHaveBeenCalledOnce();
    expect(await base.history.read(ctx.root, run.runId)).toEqual(before);
    const adapted = await runtime.adaptApply(ctx.root, run.runId);
    expect(adapted.currentStage).toBe("compose");
    expect(write).toHaveBeenCalledTimes(2);
    expect(adapted.events.at(-1)?.type).toBe("workflow-adapted");
  });

  it("advances declared read-only stages through host persistence to completion", async () => {
    await installWorkflowProfile(ctx.root, buildWorkflowProfile(ADAPT_BUILD_STAGES));
    const base = createLocalWorkflowHost();
    const write = vi.fn(base.records.write);
    const load = vi.fn(base.profiles.load);
    const host = { ...base, records: { ...base.records, write }, profiles: { ...base.profiles, load } };
    const runtime = createLocalWorkflowRuntime(host);
    const started = await runtime.start({ root: ctx.root, workflowId: "build", inputs: {} });
    expect((await runtime.advance(ctx.root, started.runId)).outcome).toBe("advanced");
    const result = await runtime.advance(ctx.root, started.runId);
    expect(result.outcome).toBe("completed");
    expect(result.run.currentStage).toBeNull();
    expect(write).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledTimes(3);
    // Normal writes sign a copy; the existing API returns its pre-signing state.
    const { integrity: _previousStamp, ...state } = result.run;
    expect(await host.history.read(ctx.root, started.runId)).toMatchObject({ status: "ok", run: state });
  });

  it("fails, resumes and cancels through host persistence with the same retained event trail", async () => {
    await installWorkflowProfile(ctx.root);
    const base = createLocalWorkflowHost();
    const write = vi.fn(base.records.write);
    const writeCandidates = vi.fn(base.records.writeCandidates);
    const host = { ...base, records: { write, writeCandidates } };
    const runtime = createLocalWorkflowRuntime(host);
    const started = await runtime.start({ root: ctx.root, workflowId: "build", inputs: { topic: "retained" } });
    const failed = await runtime.fail(ctx.root, started.runId, "retry this stage");
    expect(failed.status).toBe("failed");
    expect((await runtime.resume(ctx.root, started.runId)).status).toBe("running");
    const cancelled = await runtime.cancel(ctx.root, started.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.inputs).toEqual(started.inputs);
    expect(cancelled.events.map(event => event.type))
      .toEqual(["workflow-start", "run-failed", "run-resumed", "run-cancelled"]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(writeCandidates).toHaveBeenCalledTimes(2);
    expect(await host.history.read(ctx.root, started.runId)).toMatchObject({ status: "ok", run: cancelled });
    await expect(runtime.resume(ctx.root, started.runId)).rejects.toBeInstanceOf(RunNotActiveError);
    expect(await host.history.read(ctx.root, started.runId)).toMatchObject({ status: "ok", run: cancelled });
  });
});
