/**
 * @file test/workflow-projection.test.ts
 * @description Tests for the DERIVED markdown projection of a workflow run.
 *
 * Covers the pure renderer (`projectRun`: frontmatter fields + DERIVED header +
 * `## Stage Log` lines) and `writeProjection`: it writes the markdown to a
 * workflow's `projectionFile` under `wiki/`, returns `no-target` when the def
 * declares none, `unavailable` for an absent/unknown run (writing nothing), and
 * — the one-way contract — a hand-edit of the projection markdown never mutates
 * the run JSON (which `readRun` keeps reporting unchanged).
 */

import { describe, it, expect } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  buildWorkflowProfile,
  installWorkflowProfile,
  ADAPT_BUILD_STAGES as STAGES,
} from "./fixtures/workflow-profile.js";
import { projectRun, writeProjection } from "../src/workflows/projection.js";
import { startWorkflow } from "../src/workflows/start.js";
import { readRun } from "../src/workflows/store.js";
import type { ProfilePack } from "../src/profile/types.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, type WorkflowRun } from "../src/workflows/types.js";

/** Build a `build` profile, optionally attaching a `projectionFile`. */
function profile(projectionFile?: string): ProfilePack {
  const pack = buildWorkflowProfile(STAGES);
  if (projectionFile !== undefined) pack.workflows!.build.projectionFile = projectionFile;
  return pack;
}

/** Install `profile(projectionFile)` on disk under `<root>/.llmwiki/profile.json`. */
async function writeProfile(root: string, pack: ProfilePack): Promise<void> {
  await installWorkflowProfile(root, pack);
}

/** A minimal completed run record for pure-renderer tests. */
function sampleRun(): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    runId: "build-2026-01-01-abcd",
    workflowId: "build",
    workflowDigest: "d".repeat(64),
    profileDigest: "p".repeat(64),
    knownStageIds: ["draft", "run"],
    status: "completed",
    currentStage: null,
    stageLog: [
      { stageId: "draft", status: "completed" },
      { stageId: "run", status: "running" },
    ],
    events: [],
    satisfiedGates: [],
    inputs: { topic: "x" },
    outputs: { pages: 2 },
    stateVersion: 3,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("projectRun (pure)", () => {
  it("renders frontmatter fields, the DERIVED header, and one stage-log line per entry", () => {
    const md = projectRun(sampleRun());
    expect(md).toContain("workflow: build");
    expect(md).toContain("runId: build-2026-01-01-abcd");
    expect(md).toContain("status: completed");
    expect(md).toContain("updatedAt:");
    expect(md).toMatch(/DERIVED from the workflow run JSON/);
    expect(md).toContain("## Stage Log");
    expect(md).toContain("- draft: completed");
    expect(md).toContain("- run: running");
  });

  it("is deterministic for the same run", () => {
    expect(projectRun(sampleRun())).toBe(projectRun(sampleRun()));
  });
});

describe("writeProjection", () => {
  it("writes the projection markdown under wiki/ for a workflow with a projectionFile", async () => {
    const root = await makeTempRoot("wf-proj-write");
    await writeProfile(root, profile("wiki/outputs/workflows/build.md"));
    const run = await startWorkflow(root, "build", {});
    const result = await writeProjection(root, run.runId);
    expect(result).toEqual({ status: "written", path: "wiki/outputs/workflows/build.md" });
    const md = await readFile(path.join(root, "wiki/outputs/workflows/build.md"), "utf8");
    expect(md).toMatch(/DERIVED from the workflow run JSON/);
    expect(md).toContain("status: pending");
    expect(md).toContain("## Stage Log");
    expect(md).toContain("- draft: pending");
  });

  it("returns no-target when the workflow declares no projectionFile", async () => {
    const root = await makeTempRoot("wf-proj-none");
    await writeProfile(root, profile());
    const run = await startWorkflow(root, "build", {});
    expect(await writeProjection(root, run.runId)).toEqual({ status: "no-target" });
  });

  it("returns unavailable for an unknown run id and writes nothing", async () => {
    const root = await makeTempRoot("wf-proj-unknown");
    await writeProfile(root, profile("wiki/outputs/workflows/build.md"));
    const result = await writeProjection(root, "build-2026-01-01-9999");
    expect(result.status).toBe("unavailable");
  });

  it("refuses to clobber an existing NON-projection file at the reserved target", async () => {
    const root = await makeTempRoot("wf-proj-clobber");
    await writeProfile(root, profile("wiki/outputs/workflows/build.md"));
    const run = await startWorkflow(root, "build", {});
    const target = path.join(root, "wiki/outputs/workflows/build.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "# authored content, NOT a projection\n", "utf8");
    const result = await writeProjection(root, run.runId);
    expect(result.status).toBe("unavailable");
    expect(await readFile(target, "utf8")).toBe("# authored content, NOT a projection\n");
  });

  it("re-projects over a PRIOR projection (the derived header is present)", async () => {
    const root = await makeTempRoot("wf-proj-reproject");
    await writeProfile(root, profile("wiki/outputs/workflows/build.md"));
    const run = await startWorkflow(root, "build", {});
    expect((await writeProjection(root, run.runId)).status).toBe("written");
    const second = await writeProjection(root, run.runId);
    expect(second.status).toBe("written");
  });

  it("is one-way: hand-editing the projection markdown never mutates run state", async () => {
    const root = await makeTempRoot("wf-proj-oneway");
    await writeProfile(root, profile("wiki/outputs/workflows/build.md"));
    const run = await startWorkflow(root, "build", {});
    await writeProjection(root, run.runId);
    const mdPath = path.join(root, "wiki/outputs/workflows/build.md");
    const edited = (await readFile(mdPath, "utf8")).replace("status: pending", "status: completed");
    await writeFile(mdPath, edited, "utf8");
    const read = await readRun(root, run.runId);
    expect(read.status).toBe("ok");
    expect(read.status === "ok" && read.run.status).toBe("pending");
  });
});
