/**
 * @file test/workflow-stage-output-artifact.test.ts
 * @description The `artifact` stage-output arm: scope-gated on the stage's
 * `artifactWrites`, routed through the #9A planner→executor seam, refuse-not-park
 * (mirrors relation/lifecycle). WITH the operator grant it applies + records the
 * hash-pinned ref + a "workflow"-origin event; out-of-scope / no-grant are refused
 * (hard fail). Exercised by BOTH the research AND the newsroom profile.
 */
import { describe, it, expect, afterEach } from "vitest";
import { researchArtifactProfile, newsroomArtifactProfile, startArtifactRun, resultOutput, grantTrustedWrite, submitGrantedArtifact, expectAppliedArtifactWrite, readArtifactEventOrigin } from "./fixtures/artifact-seam-fixtures.js";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import { StageWriteScopeError, TrustGateRequiresGrantError } from "../src/workflows/errors.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import { readRun } from "../src/workflows/store.js";

afterEach(() => { delete process.env[TRUSTED_WRITE_ENV_VAR]; });

describe("submitStageOutput — artifact kind", () => {
  it("WITH the grant, applies an in-scope artifact, records the hash-pinned ref + a workflow-origin event", async () => {
    const { root, result } = await submitGrantedArtifact("art-allow", researchArtifactProfile(), resultOutput("exp-1"));
    expect(result.run.outputs.run).toMatchObject({ artifactType: "experiment-result", slug: "exp-1" });
    await expectAppliedArtifactWrite(result, root);
  });

  it("refuses an out-of-scope artifact type; nothing written, run byte-unchanged", async () => {
    const { root, runId, profileId } = await startArtifactRun("art-scope", researchArtifactProfile());
    grantTrustedWrite(profileId);
    const before = await readRun(root, runId);
    const out: StageOutput = { kind: "artifact", artifactType: "fact-check", slug: "x", body: "hi" };
    await expect(submitStageOutput(root, runId, out)).rejects.toBeInstanceOf(StageWriteScopeError);
    expect(await readRun(root, runId)).toEqual(before);
  });

  it("WITHOUT the grant, REFUSES the artifact write (hard fail), advising the grant", async () => {
    const { root, runId } = await startArtifactRun("art-nogrant", researchArtifactProfile());
    await expect(submitStageOutput(root, runId, resultOutput("exp-1"))).rejects.toThrow(/LLMWIKI_TRUSTED_WRITE/);
    const read = await readRun(root, runId);
    expect(read.status === "ok" && read.run.status).toBe("failed");
  });

  it("drives the SAME machinery for a dissimilar newsroom profile (genericity)", async () => {
    const out: StageOutput = { kind: "artifact", artifactType: "fact-check", slug: "story-1", body: "verified" };
    const { root, result } = await submitGrantedArtifact("art-newsroom", newsroomArtifactProfile(), out);
    expect(result.applied).toBe(true);
    expect(await readArtifactEventOrigin(root)).toBe("workflow");
  });

  it("REFUSES a trust:-gated artifact write WITHOUT the grant (no staged-review path), run failed", async () => {
    const { root, runId } = await startArtifactRun("art-trustgate", researchArtifactProfile("trust:review"));
    await expect(submitStageOutput(root, runId, resultOutput("exp-1"))).rejects.toBeInstanceOf(TrustGateRequiresGrantError);
    const read = await readRun(root, runId);
    expect(read.status === "ok" && read.run.status).toBe("failed");
  });

  it("DROPS a forged origin smuggled on the output object (harness-stamped, un-spoofable)", async () => {
    const { root, runId, profileId } = await startArtifactRun("art-forge", researchArtifactProfile());
    grantTrustedWrite(profileId);
    // Adversary smuggles an extra `origin: "cli"` on the output payload; the arm names
    // each mutation field + stamps origin itself, so the forged property is IGNORED.
    const forged = { ...resultOutput("exp-1"), origin: "cli" } as StageOutput;
    await submitStageOutput(root, runId, forged);
    expect(await readArtifactEventOrigin(root)).toBe("workflow"); // NOT "cli"
  });
});
