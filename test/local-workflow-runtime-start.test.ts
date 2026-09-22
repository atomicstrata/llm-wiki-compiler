/**
 * @file test/local-workflow-runtime-start.test.ts
 * @description Constructed-host creation witnesses: real persistence and passive
 * status, legacy caller-held lock compatibility, and duplicate-core refusal.
 * Other execution arms are intentionally not claimed by these start-only tests.
 */
import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { LocalWorkflowCoreInstanceError } from "../src/local-workflow-host/contracts.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";
import { startWorkflowLocked } from "../src/workflows/start.js";
import { acquireMutationLockBlocking } from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { readRun } from "../src/workflow-history/store.js";

const ctx = useConfinementRoots("constructed-workflow");

describe("constructed local workflow start", () => {
  it("persists through the host and reports the same authenticated pending run", async () => {
    await installWorkflowProfile(ctx.root);
    const host = createLocalWorkflowHost();
    const runtime = createLocalWorkflowRuntime(host);
    const run = await runtime.start({ root: ctx.root, workflowId: "build", inputs: { topic: "x" } });
    expect(run.status).toBe("pending");
    expect(run.inputs).toEqual({ topic: "x" });
    expect(await host.history.read(ctx.root, run.runId)).toMatchObject({ status: "ok", run });
    expect(await runtime.status(ctx.root, run.runId)).toMatchObject([{ classification: "current", run }]);
  });

  it("keeps the legacy acquire/start/release contract without a new token or nested lock", async () => {
    await installWorkflowProfile(ctx.root);
    await acquireMutationLockBlocking(ctx.root, "ordinary");
    let id: string;
    try {
      id = (await startWorkflowLocked(ctx.root, "build", {})).runId;
    } finally {
      await releaseLock(ctx.root);
    }
    expect(await readRun(ctx.root, id!)).toMatchObject({ status: "ok", run: { status: "pending" } });
  });

  it("refuses a second real contracts module before touching the supplied host", async () => {
    // A separate source-module identity models duplicate installed core copies.
    const duplicateModule: string = "../src/local-workflow-host/contracts.js?second-core-instance";
    const foreign = await import(duplicateModule);
    const host = createLocalWorkflowHost();
    expect(foreign.LOCAL_WORKFLOW_CORE_INSTANCE).not.toBe(host.coreInstance);
    expect(() => createLocalWorkflowRuntime({ ...host, coreInstance: foreign.LOCAL_WORKFLOW_CORE_INSTANCE }))
      .toThrow(LocalWorkflowCoreInstanceError);
    expect(await readdir(ctx.root)).toEqual([]);
  });
});
