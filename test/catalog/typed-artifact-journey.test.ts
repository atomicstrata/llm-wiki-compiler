/**
 * @file test/catalog/typed-artifact-journey.test.ts
 * @description A real artifact journey on a custom-profile `local-indexed`
 * project (the research-lite artifact profile, prepared through the real
 * set-and-prepare bodies, typed catalog `ready`): a workflow run is started,
 * and its trusted `artifact` stage output is submitted through the SDK
 * (`createWiki().submitStageOutput`). The artifact is applied with a
 * hash-pinned ref, its `workflow`-origin audit event lands in the SEGMENTED
 * event log (the incumbent events file is never written), and every indexed
 * store still verifies.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { createWiki } from "../../src/index.js";
import { verifyIndexedStores } from "../../src/indexed/verify.js";
import { diskScaleTransitionSteps, setExpectedScaleWith } from "../../src/scale/transition.js";
import { EVENTS_FILE } from "../../src/utils/constants.js";
import { TRUSTED_WRITE_ENV_VAR } from "../../src/workflows/trusted-write.js";
import { expectAppliedArtifactWrite, grantTrustedWrite, researchArtifactProfile, resultOutput, startArtifactRun } from "../fixtures/artifact-seam-fixtures.js";

let root = "";
afterEach(async () => { delete process.env[TRUSTED_WRITE_ENV_VAR]; if (root) await rm(root, { recursive: true, force: true }); });

describe("an artifact journey on an indexed custom-profile project", () => {
  it("applies a trusted artifact stage output through the SDK, its audit event in the segmented log", async () => {
    const started = await startArtifactRun("llmwiki-typed-artifact-", researchArtifactProfile());
    root = started.root;
    const steps = { ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER } };
    const report = await setExpectedScaleWith(steps, { request: { documents: 8_000 } });
    expect([report.readiness, report.record?.active.architecture, report.record?.version]).toEqual(["ready", "local-indexed", 3]);
    const incumbentEvents = existsSync(path.join(root, EVENTS_FILE));
    grantTrustedWrite(started.profileId);
    const result = await createWiki({ root }).submitStageOutput(started.runId, resultOutput("exp-indexed"));
    await expectAppliedArtifactWrite(result, root);
    expect(existsSync(path.join(root, EVENTS_FILE))).toBe(incumbentEvents);
    expect((await verifyIndexedStores(root)).ok).toBe(true);
  });
});
