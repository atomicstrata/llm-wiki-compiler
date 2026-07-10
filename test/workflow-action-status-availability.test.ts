/**
 * @file test/workflow-action-status-availability.test.ts
 * @description Regression: a `status` ACTION must not turn an unavailable runs
 * store into a clean empty result (the "unavailable store reads as empty" class,
 * resurfaced through the action wrapper).
 *
 * Mirrors `test/workflow-store-availability.test.ts`: a symlink-escaped
 * `.llmwiki/workflows` dir makes the runs store unenumerable. `runAction(root,
 * "build.status", {}, ...)` must then PRESERVE the store-unavailable problem row
 * (not drop it as a non-`build` row), and `workflow action run build.status` must
 * exit NONZERO — exactly as `workflow status` does. A readable `secret` run is
 * still object-scope-filtered OUT of a `build.status` result; a `build` run is in.
 */

import { describe, it, expect } from "vitest";
import { runAction } from "../src/workflows/run-action.js";
import { startWorkflow } from "../src/workflows/start.js";
import { installRunActionProfile, runActionProfile } from "./fixtures/run-action-profile.js";
import { escapeRunsStore } from "./fixtures/escape-runs-store.js";
import { runCLI } from "./fixtures/run-cli.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import type { RunStatus } from "../src/workflows/status.js";

const ctx = useConfinementRoots("wf-action-status");

/** Escape the runs store under the run-action profile (so `build.status` is exercised). */
function escape(): Promise<boolean> {
  return escapeRunsStore(ctx.root, ctx.outside, runActionProfile());
}

describe("status action — unavailable store surfaces (never reads as empty)", () => {
  it("PRESERVES the store-unavailable problem row through build.status (not []), via cli + sdk", async () => {
    if (!(await escape())) return; // skip: no symlinks
    for (const surface of ["cli", "sdk"] as const) {
      const rows = (await runAction(ctx.root, "build.status", {}, surface)).result as RunStatus[];
      expect(rows).toHaveLength(1);
      expect(rows[0].problem).toMatch(/run store unavailable/);
    }
  });

  it("still object-scope-filters readable runs: a secret run is OUT, a build run is IN", async () => {
    await installRunActionProfile(ctx.root);
    const build = await startWorkflow(ctx.root, "build", {});
    await startWorkflow(ctx.root, "secret", {});
    const rows = (await runAction(ctx.root, "build.status", {}, "cli")).result as RunStatus[];
    expect(rows.map((r) => r.runId)).toEqual([build.runId]);
    expect(rows.every((r) => r.run?.workflowId === "build")).toBe(true);
  });
});

describe("workflow action run <status> CLI — nonzero on an unavailable store", () => {
  it("exits NONZERO with a 'run store unavailable' message (not exit 0 / 0 run(s))", async () => {
    if (!(await escape())) return; // skip: no symlinks
    const result = await runCLI(["workflow", "action", "run", "build.status"], ctx.root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/run store unavailable|unavailable/i);
  });
});
