/**
 * @file test/local-workflow-runtime-output.test.ts
 * @description Real page-effect witnesses through a constructed local runtime.
 * Pins trust-gate parking, authorized application, pending-output refusal and
 * typed hard-denial control flow without replacing the compiler's executor.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { buildWorkflowProfile, installWorkflowProfile, experimentPageOutput } from "./fixtures/workflow-profile.js";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";
import { EntityFieldContractError } from "../src/profile/field-contract.js";
import { StageOutputPendingError } from "../src/workflows/errors.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/trust/trusted-write.js";

const ctx = useConfinementRoots("workflow-runtime-output");
afterEach(() => vi.unstubAllEnvs());

/** Install one page-writing stage and construct a run using the real compiler host. */
async function fixture(requiredField = false) {
  const profile = buildWorkflowProfile([{ id: "draft", reads: [], writes: ["experiments"], gate: "trust:review" }]);
  profile.workflows!.build.projectionFile = "wiki/outputs/workflows/build.md";
  if (requiredField) profile.entities.experiments.fields = { summary: { type: "string", required: true } };
  await installWorkflowProfile(ctx.root, profile);
  const host = createLocalWorkflowHost();
  const runtime = createLocalWorkflowRuntime(host);
  const run = await runtime.start({ root: ctx.root, workflowId: "build", inputs: {} });
  return { host, runtime, run, target: path.join(ctx.root, "wiki/experiments/example.md") };
}

describe("constructed local runtime page submission", () => {
  it("parks without a trust grant, then applies with the existing operator grant", async () => {
    vi.stubEnv(TRUSTED_WRITE_ENV_VAR, "");
    const { runtime, run, target } = await fixture();
    const output = experimentPageOutput("example");
    const parked = await runtime.submit(ctx.root, run.runId, output);
    expect(parked.applied).toBe(false);
    expect(parked.run.satisfiedGates).toEqual([]);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    vi.stubEnv(TRUSTED_WRITE_ENV_VAR, "research");
    const applied = await runtime.submit(ctx.root, run.runId, output);
    expect(applied.applied).toBe(true);
    expect(applied.run.satisfiedGates).toEqual(["trust:review"]);
    expect(applied.run.pendingOutput).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe(output.body);
    expect(await readFile(path.join(ctx.root, "wiki/outputs/workflows/build.md"), "utf8"))
      .toContain(`stateVersion: ${applied.run.stateVersion}`);
  });

  it("refuses a pending effect without applying a second write", async () => {
    vi.stubEnv(TRUSTED_WRITE_ENV_VAR, "research");
    const { host, runtime, run, target } = await fixture();
    await host.withMutation(ctx.root, tx => host.records.write(tx, ctx.root, {
      ...run, pendingOutput: { stageId: "draft", opId: `${run.runId}:draft:0` },
    }));
    const before = await host.history.read(ctx.root, run.runId);
    await expect(runtime.submit(ctx.root, run.runId, experimentPageOutput("example")))
      .rejects.toBeInstanceOf(StageOutputPendingError);
    expect(await host.history.read(ctx.root, run.runId)).toEqual(before);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes the shared typed-error identity and persists terminal failure", async () => {
    vi.stubEnv(TRUSTED_WRITE_ENV_VAR, "research");
    const { host, run, target } = await fixture(true);
    const writeCandidates = vi.fn(host.records.writeCandidates);
    const writeProjection = vi.fn(host.projections.write);
    const runtime = createLocalWorkflowRuntime({ ...host, records: { ...host.records, writeCandidates },
      projections: { write: writeProjection } });
    await expect(runtime.submit(ctx.root, run.runId, experimentPageOutput("example")))
      .rejects.toBeInstanceOf(EntityFieldContractError);
    expect(writeCandidates).toHaveBeenCalledOnce();
    expect(writeProjection).toHaveBeenCalledOnce();
    expect(await readFile(path.join(ctx.root, "wiki/outputs/workflows/build.md"), "utf8"))
      .toContain("status: failed");
    expect(await host.history.read(ctx.root, run.runId))
      .toMatchObject({ status: "ok", run: { status: "failed", outputs: {} } });
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
