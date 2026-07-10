/**
 * Subprocess integration tests for the read-only `/api/workflow-runs` viewer route.
 *
 * These spin up the compiled `llmwiki view` binary against a temp project that
 * has real workflow runs on disk, then GET `/api/workflow-runs` and assert the
 * JSON lists each run with its classification/status/currentStage/workflow.
 * Coverage mirrors `viewer-server.test.ts` and asserts the three contracts that
 * matter for this surface: runs are listed; an UNAVAILABLE run store surfaces a
 * problem row (fail-visible, never an empty list / 500); and a project with NO
 * runs returns an empty list while the existing routes keep working unchanged.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { installWorkflowProfile, WORKFLOW_PROFILE } from "./fixtures/workflow-profile.js";
import { escapeRunsStore } from "./fixtures/escape-runs-store.js";
import { startWorkflow } from "../src/workflows/start.js";
import { useViewerProcessLifecycle } from "./fixtures/run-cli-server.js";
import { fetchJson } from "./fixtures/viewer-fetch.js";

const { start: startViewer } = useViewerProcessLifecycle();

/** A single `/api/workflow-runs` row shape. */
interface RunRow {
  runId: string;
  classification: string;
  status?: string;
  currentStage?: string | null;
  workflow?: string;
  problem?: string;
}

/** Read the `runs` array out of the `/api/workflow-runs` envelope. */
function rowsOf(body: unknown): RunRow[] {
  return (body as { runs: RunRow[] }).runs;
}

describe("llmwiki view — /api/workflow-runs", () => {
  it("lists runs with classification, status, currentStage, and workflow", async () => {
    const root = await makeTempRoot("viewer-wf-runs-list");
    await installWorkflowProfile(root);
    const run = await startWorkflow(root, "build", {});
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/workflow-runs");
    expect(status).toBe(200);
    const rows = rowsOf(body);
    const row = rows.find((r) => r.runId === run.runId);
    expect(row).toBeDefined();
    expect(row?.workflow).toBe("build");
    expect(row?.classification).toBe("current");
    expect(row?.status).toBe("pending");
    expect(row?.currentStage).toBe("draft");
  });

  it("surfaces a problem row (not empty, not 500) for an unavailable run store", async () => {
    const root = await makeTempRoot("viewer-wf-runs-unavailable");
    const outside = await makeOutsideDir();
    if (!(await escapeRunsStore(root, outside, WORKFLOW_PROFILE))) return; // skip: no symlinks
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/workflow-runs");
    expect(status).toBe(200);
    const rows = rowsOf(body);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => /unavailable/.test(r.problem ?? ""))).toBe(true);
  });

  it("returns an empty list with no runs, and existing routes still work", async () => {
    const root = await makeTempRoot("viewer-wf-runs-empty");
    await installWorkflowProfile(root);
    const handle = await startViewer(root);
    const runs = await fetchJson(handle, "/api/workflow-runs");
    expect(runs.status).toBe(200);
    expect(rowsOf(runs.body)).toEqual([]);
    const pages = await fetchJson(handle, "/api/pages");
    expect(pages.status).toBe(200);
    expect((pages.body as { counts: unknown }).counts).toBeDefined();
  });

  it("registers the route so the drift guard does not 404 it", async () => {
    const root = await makeTempRoot("viewer-wf-runs-registered");
    const handle = await startViewer(root);
    const { status } = await fetchJson(handle, "/api/workflow-runs");
    expect(status).toBe(200);
  });
});
