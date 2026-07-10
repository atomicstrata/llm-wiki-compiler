/**
 * @file test/workflow-status-next-hint.test.ts
 * @description Tests for the `next:` action hint in `workflow status` rendering.
 *
 * An `awaiting-gate` run's status carries the gate id and its rendered line
 * includes a `gate approve` next-hint naming that gate; an `awaiting-output` run
 * carries a declared write entity type and its rendered line includes a `submit`
 * next-hint naming that entity type. The structured fields are unchanged; the hint
 * is an extra human-readable line.
 */

import { describe, it, expect, vi } from "vitest";
import { startAndParkBuild } from "./fixtures/workflow-profile.js";
import { workflowStatus, type RunStatus } from "../src/workflows/status.js";
import { printRunStatus } from "../src/commands/workflow-shared.js";
import type { WorkflowRun } from "../src/workflows/types.js";

/** Capture every console.log line printed by `fn`. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("workflow status next-hint", () => {
  it("includes a gate-approve hint naming the gate id for an awaiting-gate run", async () => {
    const { root, runId } = await startAndParkBuild("wf-hint-gate", [
      { id: "review", reads: ["ideas"], writes: [], gate: "agent:reviewer" },
    ]);
    const [status] = await workflowStatus(root, runId);
    expect(status.awaitingGate).toBe("reviewer");
    const lines = captureLog(() => printRunStatus(status));
    expect(lines.join("\n")).toContain(`next: workflow gate approve ${runId} reviewer`);
  });

  it("includes a submit hint naming a declared write entity type for an awaiting-output run", async () => {
    const { root, runId } = await startAndParkBuild("wf-hint-output", [
      { id: "draft", reads: ["ideas"], writes: ["experiments"] },
    ]);
    const [status] = await workflowStatus(root, runId);
    expect(status.awaitingOutput).toBe(true);
    expect(status.nextSubmitEntityType).toBe("experiments");
    const lines = captureLog(() => printRunStatus(status));
    expect(lines.join("\n")).toContain("next: workflow submit");
    expect(lines.join("\n")).toContain("--entity-type experiments");
  });

  it("hints the trusted-write grant + submit (NOT gate approve) for a trust-gated write park", async () => {
    const { root, runId } = await startAndParkBuild("wf-hint-trust", [
      { id: "review", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" },
    ]);
    const [status] = await workflowStatus(root, runId);
    expect(status.awaitingTrustGate).toBe(true);
    const hint = captureLog(() => printRunStatus(status)).join("\n");
    expect(hint).toContain("LLMWIKI_TRUSTED_WRITE");
    expect(hint).toContain("workflow submit");
    expect(hint).not.toContain("gate approve"); // the approve path fails on a trust gate
  });

  it("hints events + resume for a failed run", () => {
    const status: RunStatus = { runId: "run_x", classification: "current", run: { status: "failed" } as unknown as WorkflowRun };
    const hint = captureLog(() => printRunStatus(status)).join("\n");
    expect(hint).toContain("workflow events run_x");
    expect(hint).toContain("workflow resume run_x");
  });
});
