/**
 * Standard CLI/MCP compatibility paths must refuse a second core instance before
 * I/O, including the legacy caller-held-lock entry. Keep the real engine and
 * substitute only the host's token from a separately loaded contracts module.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readdir } from "node:fs/promises";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("wrapper-core-identity");

beforeEach(() => {
  vi.resetModules();
  vi.doMock("@atomicstrata/llmwiki-core/local-workflow-host", async importOriginal => {
    const original = await importOriginal<typeof import("../src/local-workflow-host/index.js")>();
    const duplicateModule: string = "../src/local-workflow-host/contracts.js?wrapper-second-core";
    const foreign = await import(duplicateModule);
    return { ...original, createLocalWorkflowHost: () => ({
      ...original.createLocalWorkflowHost(), coreInstance: foreign.LOCAL_WORKFLOW_CORE_INSTANCE,
    }) };
  });
});

afterEach(() => {
  vi.doUnmock("@atomicstrata/llmwiki-core/local-workflow-host");
  vi.resetModules();
});

it("refuses standard submit during host composition without touching the root", async () => {
  await expect(import("../src/workflows/stage-output.js"))
    .rejects.toMatchObject({ name: "LocalWorkflowCoreInstanceError" });
  expect(await readdir(ctx.root)).toEqual([]);
});

it("refuses the module exposing startWorkflowLocked before it can sign a run", async () => {
  await expect(import("../src/workflows/start.js"))
    .rejects.toMatchObject({ name: "LocalWorkflowCoreInstanceError" });
  expect(await readdir(ctx.root)).toEqual([]);
});

it("refuses a call-time CLI/MCP wrapper host before reading or locking", async () => {
  const { cancelWorkflow } = await import("../src/workflows/cancel.js");
  await expect(cancelWorkflow(ctx.root, "missing-run"))
    .rejects.toMatchObject({ name: "LocalWorkflowCoreInstanceError" });
  expect(await readdir(ctx.root)).toEqual([]);
});
