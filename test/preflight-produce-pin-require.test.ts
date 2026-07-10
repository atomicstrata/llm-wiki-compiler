/**
 * @file test/preflight-produce-pin-require.test.ts
 * @description CLP 7.7 preflight-proof, Task 2: the full produce->pin->require
 * artifact chain, proven end-to-end over the real CLI on both combined profiles
 * (research + newsroom). A workflow run PRODUCES a typed artifact (the `produce`
 * stage, driven via {@link driveProduceStage} per Task 1's discovered submit-then-
 * advance ordering requirement), the produced ref is then MANUALLY PINNED into the
 * downstream draft page's create body through the real `workflow submit --kind page`
 * surface, exactly as an author templating the ref would (computed independently by
 * the test via {@link computePinnedRef}, never read back from the run), and the
 * page's terminal lifecycle transition is driven:
 *
 * - ACCEPT: with the ref pinned, the gated transition APPLIES and the run completes.
 * - DENY: with the ref NOT pinned, the transition is HARD DENIED with
 *   `ArtifactPreconditionUnmetError` (`artifact preconditions unmet: ...`), and the
 *   entity page remains at its initial lifecycle state (the write never landed).
 *
 * Both cases are asserted directly against the persisted entity page on disk
 * (`entityPagePath`), not merely against CLI exit codes, so the proof covers the
 * actual write outcome the gate is meant to control.
 */
import { describe, it, expect } from "vitest";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { makeResearchLiteProjectRoot } from "./fixtures/profile-fixtures.js";
import { startRun, driveStage, entityPagePath, expectCompleted } from "./fixtures/research-workflow.js";
import {
  PREFLIGHT_PROFILES,
  PREFLIGHT_GRANT,
  preflightProfilePack,
  driveProduceThenDraft,
  publishTransitionArgs,
} from "./fixtures/preflight-profiles.js";
import { readFile } from "node:fs/promises";

describe.each(PREFLIGHT_PROFILES)("preflight produce->pin->require ($id)", (p) => {
  it("ACCEPTS the gated transition when the produced ref is pinned", async () => {
    const root = await makeResearchLiteProjectRoot("preflight-pin-accept-", preflightProfilePack(p));
    const runId = await startRun(root, p.workflowId, PREFLIGHT_GRANT);
    await driveProduceThenDraft(root, runId, p, PREFLIGHT_GRANT, true);

    const done = await driveStage(root, runId, publishTransitionArgs(root, runId, p), PREFLIGHT_GRANT);
    expectCompleted(done);

    const page = await readFile(entityPagePath(root, p.entityType, p.slug), "utf8");
    expect(page).toMatch(new RegExp(`${p.lifecycleField}:\\s*${p.gatedState}`));
  });

  it("DENIES the gated transition when the produced ref is not pinned", async () => {
    const root = await makeResearchLiteProjectRoot("preflight-pin-deny-", preflightProfilePack(p));
    const runId = await startRun(root, p.workflowId, PREFLIGHT_GRANT);
    await driveProduceThenDraft(root, runId, p, PREFLIGHT_GRANT, false);

    expectCLIExit(await runCLI(["workflow", "advance", runId], root, PREFLIGHT_GRANT), 0);
    const denied = await runCLI(publishTransitionArgs(root, runId, p), root, PREFLIGHT_GRANT);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/artifact preconditions unmet:/);

    const page = await readFile(entityPagePath(root, p.entityType, p.slug), "utf8");
    expect(page).toMatch(new RegExp(`${p.lifecycleField}:\\s*${p.initialState}`));
  });
});
