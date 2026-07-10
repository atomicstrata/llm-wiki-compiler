/**
 * @file test/sdk/workflow-lifecycle-sdk.test.ts
 * @description Tests the EXPERIMENTAL `createWiki()` workflow LIFECYCLE methods
 * in-process (`advanceWorkflow`, `approveGate`, `cancelWorkflow`, `resumeWorkflow`).
 *
 * Over a `build` workflow whose stage 1 is ungated and stage 2 carries an
 * `agent:` gate: advance past stage 1, advance to park awaiting-gate, approve the
 * gate as an agent, advance to completion; cancel a fresh run leaves it `cancelled`.
 *
 * C1: the SDK is a PROGRAMMATIC surface, so it can NEVER satisfy a `human:` gate —
 * `approveGate(..., { actorKind: "human" })` fails closed with `SdkHumanGateError`
 * (a human gate is producible only by the interactive CLI proof).
 */

import { describe, it, expect } from "vitest";
import { useWorkflowRoot, startBuildRun } from "../fixtures/workflow-profile.js";
import { SdkHumanGateError } from "../../src/workflows/errors.js";
import { readRun } from "../../src/workflows/store.js";

const ctx = useWorkflowRoot("sdk-workflow-lifecycle-", [
  { id: "draft", reads: ["ideas"], writes: [] },
  { id: "review", reads: ["ideas"], writes: [], gate: "agent:check" },
]);

const humanCtx = useWorkflowRoot("sdk-workflow-human-gate-", [
  { id: "draft", reads: ["ideas"], writes: [] },
  { id: "review", reads: ["ideas"], writes: [], gate: "human:lead" },
]);

describe("createWiki workflow lifecycle slice (experimental)", () => {
  it("advances, parks awaiting-gate, approves an agent gate, and completes", async () => {
    const { wiki, runId } = await startBuildRun(ctx.root);

    expect((await wiki.advanceWorkflow(runId)).outcome).toBe("advanced");
    expect((await wiki.advanceWorkflow(runId)).outcome).toBe("awaiting-gate");

    const approved = await wiki.approveGate(runId, "check", { actorKind: "agent" });
    expect(approved.satisfiedGates).toContain("agent:check");

    expect((await wiki.advanceWorkflow(runId)).outcome).toBe("completed");
  });

  it("cancels a fresh run", async () => {
    const { wiki, runId } = await startBuildRun(ctx.root);
    const cancelled = await wiki.cancelWorkflow(runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("C1: the SDK cannot satisfy a human gate", () => {
  it("fails closed with SdkHumanGateError and satisfies nothing", async () => {
    const { wiki, runId } = await startBuildRun(humanCtx.root);
    await wiki.advanceWorkflow(runId);
    await wiki.advanceWorkflow(runId);

    await expect(wiki.approveGate(runId, "lead", { actorKind: "human" })).rejects.toBeInstanceOf(
      SdkHumanGateError,
    );

    const read = await readRun(humanCtx.root, runId);
    if (read.status !== "ok") throw new Error(`run not ok: ${read.status}`);
    expect(read.run.satisfiedGates).toEqual([]);
  });
});
