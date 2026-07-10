/**
 * @file test/workflow-submit-artifact-subprocess.test.ts
 * @description Real-subprocess test for `workflow submit --kind artifact` over
 * `dist/cli.js` — the runtime counterpart to the command-level test in
 * `workflow-submit-artifact-cli.test.ts`. Stages a `build` run in a tmp
 * research-artifact profile workspace, submits an `experiment-result` artifact
 * output through the COMPILED binary (with the operator's trusted-write grant),
 * and asserts the recorded `artifact-write` event carries the CLI's `"workflow"`
 * origin — proving the `--kind artifact` flag → `StageOutput` → artifact arm
 * path works end to end through the built CLI, not just in-process.
 */
import { describe, it, afterEach, expect } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { makeResearchLiteProjectRoot } from "./fixtures/profile-fixtures.js";
import { researchArtifactProfile, readArtifactEventOrigin } from "./fixtures/artifact-seam-fixtures.js";

const GRANT = { LLMWIKI_TRUSTED_WRITE: "*" };

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow submit --kind artifact (subprocess)", () => {
  it("submits an artifact output through the compiled CLI, recording a workflow-origin event", async () => {
    root = await makeResearchLiteProjectRoot("art-subproc-", researchArtifactProfile());
    const start = await runCLI(["workflow", "start", "build"], root);
    expectCLIExit(start, 0);
    const runId = (start.stdout.match(/build-[\w-]+/) ?? [""])[0];

    const bodyFile = path.join(root, "body.json");
    await writeFile(bodyFile, `{"accuracy":0.9}`, "utf8");
    const submit = await runCLI(
      ["workflow", "submit", runId, "--kind", "artifact", "--artifact-type", "experiment-result", "--slug", "exp-1", "--body-file", bodyFile],
      root,
      GRANT,
    );

    expectCLIExit(submit, 0);
    expect(submit.stdout).toMatch(/applied/i);
    expect(await readArtifactEventOrigin(root)).toBe("workflow");
  });
});
