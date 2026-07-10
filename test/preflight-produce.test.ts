/**
 * @file test/preflight-produce.test.ts
 * @description CLP 7.7 preflight-proof, Task 1: the PRODUCE leg of the
 * produce->pin->require artifact chain, proven generically across two
 * combined profiles (research + newsroom). Each profile's `publish-pipeline`
 * workflow's `produce` stage writes a typed artifact via `workflow submit
 * --kind artifact`; this test drives that single stage over the real CLI and
 * asserts the recorded `run.outputs["produce"]` shape — {@link
 * ArtifactStageOutput}'s applied result — matches the submitted artifact and
 * that its recorded `sha256` is the SAME hash the artifact store itself would
 * recompute from the submitted body (closing the produce->pin circularity
 * concern: the assertion does not merely assume the two hashes agree, it
 * proves it by recomputing one side independently via `hashArtifactBody`).
 */
import { describe, it, expect } from "vitest";
import { readRun } from "../src/workflows/store.js";
import { hashArtifactBody } from "../src/artifacts/store.js";
import { makeResearchLiteProjectRoot } from "./fixtures/profile-fixtures.js";
import { startRun } from "./fixtures/research-workflow.js";
import {
  PREFLIGHT_PROFILES,
  PREFLIGHT_GRANT,
  preflightProfilePack,
  artifactSubmitArgs,
  driveProduceStage,
} from "./fixtures/preflight-profiles.js";

describe.each(PREFLIGHT_PROFILES)("preflight produce leg ($id)", (p) => {
  it("records run.outputs[\"produce\"] matching the submitted artifact", async () => {
    const root = await makeResearchLiteProjectRoot("preflight-produce-", preflightProfilePack(p));
    const runId = await startRun(root, p.workflowId, PREFLIGHT_GRANT);
    await driveProduceStage(
      root,
      runId,
      await artifactSubmitArgs(root, runId, p.artifactType, p.slug, p.artifactBody),
      PREFLIGHT_GRANT,
    );

    const read = await readRun(root, runId);
    if (read.status !== "ok") throw new Error(`run not readable: ${JSON.stringify(read)}`);
    const out = read.run.outputs[p.produceStageId] as {
      artifactType: string;
      slug: string;
      sha256: string;
      decision: string;
    };
    expect(out.artifactType).toBe(p.artifactType);
    expect(out.slug).toBe(p.slug);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Tie the RECORDED produce sha256 to the body the pin recomputes -> the
    // produce->pin linkage is VALIDATED, not assumed.
    expect(out.sha256).toBe(hashArtifactBody(p.artifactBody));
    expect(out.decision).toBeDefined();
  });
});
