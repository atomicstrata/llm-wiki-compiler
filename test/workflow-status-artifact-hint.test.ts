/**
 * @file test/workflow-status-artifact-hint.test.ts
 * @description Subprocess-level regression for the operator-facing `workflow
 * status` submit hint on a parked ARTIFACT-ONLY stage (`writes: []`,
 * `artifactWrites: [t]`). Before this fix, `submitHint` hardcoded
 * `--kind page --entity-type <entity-type>` regardless of what actually parked,
 * so an operator at an artifact-only park was told to run a submit that always
 * fails (no declared entity type, no writes to satisfy). The hint must instead
 * read `--kind artifact --artifact-type <t>` when there is no entity-type hint
 * but there is an artifact-type hint. Runs the real compiled CLI (`dist/cli.js`)
 * end to end: the hint text is what the operator actually SEES, and `submitHint`
 * itself is module-private, so only a CLI-level assertion proves the fix.
 */
import { describe, it, afterEach, expect } from "vitest";
import { rm } from "node:fs/promises";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { researchArtifactProfile, startArtifactRun } from "./fixtures/artifact-seam-fixtures.js";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workflow status — artifact-only park submit hint", () => {
  it("hints `--kind artifact --artifact-type <t>`, not `--kind page`, for a parked artifact-only stage", async () => {
    const started = await startArtifactRun("wf-status-artifact-hint-", researchArtifactProfile());
    root = started.root;

    const advance = await runCLI(["workflow", "advance", started.runId], root);
    expectCLIExit(advance, 0);

    const status = await runCLI(["workflow", "status", started.runId], root);
    expectCLIExit(status, 0);
    expect(status.stdout).toMatch(/--kind artifact --artifact-type experiment-result/);
    expect(status.stdout).not.toMatch(/--kind page/);
  });
});
