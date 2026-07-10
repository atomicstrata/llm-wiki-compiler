/**
 * @file test/workflow-submit-action.test.ts
 * @description Tests for the `submit` action operation (M6e).
 *
 * A `submit` action routes to `submitStageOutput` with the output kind/fields drawn
 * from its inputs: a page output applies/stages per the trust rules. On the `mcp`
 * surface it is capped at staged-write (the `submit` op requires exactly that, so it
 * is permitted). An out-of-scope `--entity-type` is rejected by the scope guard.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { PROFILE_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";
import { runAction } from "../src/workflows/run-action.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { StageWriteScopeError } from "../src/workflows/errors.js";
import type { ProfilePack, ActionSurface } from "../src/profile/types.js";
import type { SubmitResult } from "../src/workflows/stage-output.js";

// A page-shaped `submit` action: its inputSchema declares the page fields the
// marshaller consumes (entityType/slug/body) + runId — NO `kind` discriminator (a
// submit action is page- or artifact-shaped; the validator rejects a relation/
// lifecycle submit action, whose object payload no action input can carry).
const PAGE_INPUT_SCHEMA = {
  runId: { type: "string", required: true },
  entityType: { type: "string", required: true },
  slug: { type: "string", required: true },
  body: { type: "string", required: true },
} as const;

/** A profile whose `build.submit` action submits a page to the first (write-declaring) stage. */
function submitActionProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { ideas: { directory: "wiki/ideas" }, experiments: { directory: "wiki/experiments" } },
    workflows: { build: { stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }] } },
    workflowActions: {
      "build.submit": {
        label: "Submit build output",
        workflow: "build",
        operation: "submit",
        permissions: { cli: "staged-write", sdk: "staged-write", mcp: "staged-write", viewer: "staged-write" },
        trustGate: "trust:writer",
        inputSchema: PAGE_INPUT_SCHEMA,
      },
    },
  };
}

/** Install the submit-action profile and start+park a `build` run on its write stage. */
async function setup(prefix: string): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(submitActionProfile()), "utf8");
  const run = await startWorkflow(root, "build", {});
  await advanceWorkflow(root, run.runId); // parks awaiting-output on `draft`
  return { root, runId: run.runId };
}

/** A valid page-submit input set for `entityType`. */
function pageInputs(runId: string, entityType: string) {
  return { runId, entityType, slug: "alpha", body: "---\ntitle: alpha\n---\nbody" };
}

describe("submit action operation", () => {
  it("routes a page submit through submitStageOutput (records the stage output)", async () => {
    const { root, runId } = await setup("wf-submit-action");
    const result = await runAction(root, "build.submit", pageInputs(runId, "ideas"), "cli" as ActionSurface);
    expect(result.operation).toBe("submit");
    const submit = result.result as SubmitResult;
    expect(submit.run.events.some((e) => e.type === "stage-output")).toBe(true);
  });

  it("is permitted on the mcp surface (capped at staged-write, which submit requires)", async () => {
    const { root, runId } = await setup("wf-submit-action-mcp");
    const result = await runAction(root, "build.submit", pageInputs(runId, "ideas"), "mcp" as ActionSurface);
    expect(result.effectivePermission).toBe("staged-write");
    expect(result.operation).toBe("submit");
  });

  it("rejects an out-of-scope entity type via the scope guard", async () => {
    const { root, runId } = await setup("wf-submit-action-scope");
    await expect(
      runAction(root, "build.submit", pageInputs(runId, "experiments"), "cli" as ActionSurface),
    ).rejects.toBeInstanceOf(StageWriteScopeError);
  });
});
