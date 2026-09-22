/**
 * The projection host may persist only recognizably derived output, including on
 * first creation. This is format admission, not authentication of rendered facts.
 */
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createWiki } from "../src/sdk/wiki.js";

const ctx = useConfinementRoots("projection-body");

it.each(["authored content", "é".repeat(2048)])(
  "refuses an unrecognizable body without creating a projection target", async body => {
    const profile = buildWorkflowProfile([{ id: "draft", reads: [], writes: ["ideas"] }]);
    const target = "wiki/outputs/workflows/build.md";
    profile.workflows!.build.projectionFile = target;
    await installWorkflowProfile(ctx.root, profile);
    const host = createLocalWorkflowHost();
    expect(await host.projections.write(ctx.root, "build", body))
      .toEqual({ status: "unavailable", detail: "projection body is not a derived projection page" });
    await expect(readFile(path.join(ctx.root, target))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("preserves public first-time rendering with frontmatter beyond the overwrite probe window", async () => {
  const profile = buildWorkflowProfile([{ id: "draft", reads: [], writes: ["ideas"] }]);
  const target = "wiki/outputs/workflows/build.md";
  profile.workflows!.build.projectionFile = target;
  await installWorkflowProfile(ctx.root, profile);
  const wiki = createWiki({ root: ctx.root });
  const run = await wiki.startWorkflow("build", { topic: "é".repeat(2048) });
  expect(await wiki.projectWorkflowRun(run.runId)).toEqual({ status: "written", path: target });
  const bytes = await readFile(path.join(ctx.root, target));
  expect(bytes.indexOf("<!-- DERIVED from the workflow run JSON")).toBeGreaterThan(2048);
});
