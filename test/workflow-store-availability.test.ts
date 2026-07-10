/**
 * @file test/workflow-store-availability.test.ts
 * @description FIX 4 regression: an UNAVAILABLE run store must NOT read as "no
 * runs" (the unavailable-store-reads-as-healthy class).
 *
 * A symlink-escaped intermediate `.llmwiki/workflows` dir (mirroring the existing
 * confine test) makes the runs store unenumerable. `listRuns` then reports
 * `unavailable` (not a clean empty), and `workflowStatus(root)` surfaces a
 * problem row so the `workflow status` CLI exits non-zero instead of reporting a
 * silently-clean, empty run list.
 */

import { describe, it, expect } from "vitest";
import { listRuns } from "../src/workflows/store.js";
import { workflowStatus } from "../src/workflows/status.js";
import { runCLI } from "./fixtures/run-cli.js";
import { WORKFLOW_PROFILE } from "./fixtures/workflow-profile.js";
import { escapeRunsStore } from "./fixtures/escape-runs-store.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("wf-availability");

/** Escape the runs store under the (action-less) workflow profile. */
function escape(): Promise<boolean> {
  return escapeRunsStore(ctx.root, ctx.outside, WORKFLOW_PROFILE);
}

describe("FIX 4 — unavailable run store surfaces (never reads as empty)", () => {
  it("listRuns reports unavailable (not a clean empty) for an escaped workflows dir", async () => {
    if (!(await escape())) return; // skip: no symlinks
    expect((await listRuns(ctx.root)).status).toBe("unavailable");
  });

  it("workflowStatus surfaces a problem row instead of reporting no runs", async () => {
    if (!(await escape())) return; // skip: no symlinks
    const statuses = await workflowStatus(ctx.root);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].problem).toMatch(/run store unavailable/);
    expect(statuses[0].classification).toBe("blocked-by-config");
  });

  it("the `workflow status` CLI exits non-zero on an unavailable store", async () => {
    if (!(await escape())) return; // skip: no symlinks
    const result = await runCLI(["workflow", "status"], ctx.root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/unavailable/i);
  });
});
