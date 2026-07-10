/**
 * @file test/workflow-submit-artifact-cli.test.ts
 * @description The `workflow submit --kind artifact` command builds an artifact
 * stage output from `--artifact-type/--slug/--body-file` and routes it through
 * submitStageOutput (default "workflow" origin). Command-level (not subprocess):
 * asserts the built output + applied result via the exported command fn.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { researchArtifactProfile, startArtifactRun, grantTrustedWrite, readArtifactEventOrigin } from "./fixtures/artifact-seam-fixtures.js";
import { workflowSubmitCommand } from "../src/commands/workflow.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";

afterEach(() => { delete process.env[TRUSTED_WRITE_ENV_VAR]; process.chdir(cwd); });
const cwd = process.cwd();

describe("workflow submit --kind artifact", () => {
  it("submits an artifact output through the CLI, recording a workflow-origin event", async () => {
    const { root, runId, profileId } = await startArtifactRun("art-cli", researchArtifactProfile());
    grantTrustedWrite(profileId);
    const bodyFile = path.join(root, "body.json");
    await writeFile(bodyFile, `{"accuracy":0.9}`, "utf8");
    process.chdir(root);
    await workflowSubmitCommand(runId, { kind: "artifact", artifactType: "experiment-result", slug: "exp-1", bodyFile });
    expect(await readArtifactEventOrigin(root)).toBe("workflow");
  });
});
