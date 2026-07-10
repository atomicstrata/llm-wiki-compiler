/**
 * @file test/workflow-projection-sdk.test.ts
 * @description Tests for the experimental `projectWorkflowRun` SDK facade method:
 * it writes a run's DERIVED projection under `wiki/` (`written`) and reports
 * `no-target` when the workflow declares no `projectionFile`.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installWorkflowProfile, buildWorkflowProfile, ADAPT_BUILD_STAGES } from "./fixtures/workflow-profile.js";
import { createWiki } from "../src/sdk/wiki.js";
import type { ProfilePack } from "../src/profile/types.js";

/** The `build` profile fixture with a `projectionFile` attached. */
function profileWithProjection(): ProfilePack {
  const pack = buildWorkflowProfile(ADAPT_BUILD_STAGES);
  pack.workflows!.build.projectionFile = "wiki/outputs/workflows/build.md";
  return pack;
}

describe("Wiki projectWorkflowRun facade", () => {
  it("writes the DERIVED projection under wiki/", async () => {
    const root = await makeTempRoot("wf-proj-sdk-write");
    await installWorkflowProfile(root, profileWithProjection());
    const wiki = createWiki({ root });
    const run = await wiki.startWorkflow("build", {});
    const result = await wiki.projectWorkflowRun(run.runId);
    expect(result).toEqual({ status: "written", path: "wiki/outputs/workflows/build.md" });
    const md = await readFile(path.join(root, "wiki/outputs/workflows/build.md"), "utf8");
    expect(md).toMatch(/DERIVED from the workflow run JSON/);
  });

  it("reports no-target when the workflow declares no projectionFile", async () => {
    const root = await makeTempRoot("wf-proj-sdk-none");
    await installWorkflowProfile(root, buildWorkflowProfile(ADAPT_BUILD_STAGES));
    const wiki = createWiki({ root });
    const run = await wiki.startWorkflow("build", {});
    expect(await wiki.projectWorkflowRun(run.runId)).toEqual({ status: "no-target" });
  });
});
