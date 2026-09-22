/**
 * @file test/workflow-human-input-cli.test.ts
 * @description Real-subprocess witness that the generic workflow CLI accepts
 * only caller payload bytes for a declarative human-input stage and routes them
 * through the same core admission and host-stamped envelope as the SDK surface.
 */

import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { readRun } from "../src/workflows/store.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

async function fixture() {
  const root = await makeTempRoot("workflow-human-input-cli");
  await installWorkflowProfile(root, {
    schemaVersion: 1, profileId: "human-input-cli", entities: { notes: { directory: "wiki/notes" } },
    workflows: { story: { stages: [{
      id: "frame", reads: [], writes: [],
      humanInput: { schemaVersion: 1, schemaId: "story/frame-v1", fields: {
        angle: { kind: "string", maxBytes: 80, required: true },
        format: { kind: "enum", values: ["brief", "feature"], default: "brief" },
      } },
    }] } },
  });
  const run = await startWorkflow(root, "story", {});
  const inputFile = path.join(root, "frame.json");
  await writeFile(inputFile, JSON.stringify({ angle: "Follow the evidence" }), "utf8");
  return { root, runId: run.runId, inputFile };
}

describe("workflow human-input CLI", () => {
  it("submits a JSON object and records a host-controlled envelope", async () => {
    process.env.LLMWIKI_ACTOR = "cli-editor";
    try {
      const { root, runId, inputFile } = await fixture();
      const result = await runCLI(["workflow", "submit", runId, "--kind", "human-input", "--output-file", inputFile], root, { LLMWIKI_ACTOR: "cli-editor" });
      expectCLIExit(result, 0);
      expect(result.stdout).toMatch(/human-input.*accepted/i);
      const read = await readRun(root, runId);
      expect(read.status).toBe("ok");
      if (read.status === "ok") expect(read.run.outputs.frame).toMatchObject({ submittedBy: "cli-editor", payload: { angle: "Follow the evidence", format: "brief" } });
    } finally { delete process.env.LLMWIKI_ACTOR; }
  });

  it("rejects a non-object JSON payload without changing the run", async () => {
    const { root, runId, inputFile } = await fixture();
    await writeFile(inputFile, JSON.stringify(["not", "an", "object"]), "utf8");
    const before = await readRun(root, runId);
    const result = await runCLI(["workflow", "submit", runId, "--kind", "human-input", "--output-file", inputFile], root);
    expect(result.code).not.toBe(0);
    expect(await readRun(root, runId)).toEqual(before);
  });
});
