/**
 * @file test/workflow-artifact-immutable.test.ts
 * @description M2: workflow-produced artifacts are immutable-once-written. A second
 * run producing the SAME `(artifactType, slug)` with matching bytes is a no-op
 * (same stable sha256, no rewrite); with DIFFERENT bytes it is a hard error and the
 * original artifact is left byte-unchanged (never a silent overwrite).
 */
import { describe, it, expect, afterEach } from "vitest";
import { researchArtifactProfile, startArtifactRun, resultOutput, grantTrustedWrite, countArtifactWriteEvents } from "./fixtures/artifact-seam-fixtures.js";
import { submitStageOutput } from "../src/workflows/stage-output.js";
import { WorkflowArtifactChangedError, WorkflowArtifactUnverifiableError } from "../src/workflows/errors.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import { artifactPaths } from "../src/artifacts/store.js";
import { startWorkflow } from "../src/workflows/start.js";
import { readFile, writeFile } from "node:fs/promises";

afterEach(() => { delete process.env[TRUSTED_WRITE_ENV_VAR]; });

describe("workflow artifact re-run (M2)", () => {
  it("no-ops a byte-identical re-run: same sha256 AND no new artifact-write event", async () => {
    const { root, runId, profileId } = await startArtifactRun("art-m2-match", researchArtifactProfile());
    grantTrustedWrite(profileId);
    const first = await submitStageOutput(root, runId, resultOutput("exp-1"));
    const writesBefore = await countArtifactWriteEvents(root);
    const runB = await startWorkflow(root, "build", {});
    const second = await submitStageOutput(root, runB.runId, resultOutput("exp-1"));
    expect((second.run.outputs.run as { sha256: string }).sha256).toBe((first.run.outputs.run as { sha256: string }).sha256);
    expect(await countArtifactWriteEvents(root)).toBe(writesBefore); // applied-once short-circuit: no rewrite
  });

  it("hard-errors a divergent re-run and leaves the original bytes unchanged", async () => {
    const { root, runId, profileId } = await startArtifactRun("art-m2-diff", researchArtifactProfile());
    grantTrustedWrite(profileId);
    await submitStageOutput(root, runId, resultOutput("exp-1", `{"accuracy":0.9}`));
    const { bytesPath } = artifactPaths(root, "experiment-result", "exp-1", "result.json");
    const runB = await startWorkflow(root, "build", {});
    await expect(submitStageOutput(root, runB.runId, resultOutput("exp-1", `{"accuracy":0.5}`)))
      .rejects.toBeInstanceOf(WorkflowArtifactChangedError);
    expect(await readFile(bytesPath, "utf8")).toBe(`{"accuracy":0.9}`);
  });

  it("fails CLOSED on a malformed manifest: refuses the re-run and leaves bytes intact", async () => {
    const { root, runId, profileId } = await startArtifactRun("art-m2-malformed", researchArtifactProfile());
    grantTrustedWrite(profileId);
    await submitStageOutput(root, runId, resultOutput("exp-1", `{"accuracy":0.9}`));
    const { bytesPath, manifestPath } = artifactPaths(root, "experiment-result", "exp-1", "result.json");
    await writeFile(manifestPath, "{ not: valid json", "utf8"); // regular file, corrupt JSON — lstat does NOT catch it
    const runB = await startWorkflow(root, "build", {});
    await expect(submitStageOutput(root, runB.runId, resultOutput("exp-1", `{"accuracy":0.5}`)))
      .rejects.toBeInstanceOf(WorkflowArtifactUnverifiableError);
    expect(await readFile(bytesPath, "utf8")).toBe(`{"accuracy":0.9}`); // original bytes never overwritten
  });
});
