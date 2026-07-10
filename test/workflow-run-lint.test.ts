/**
 * @file test/workflow-run-lint.test.ts
 * @description Tests for the `workflow-run-health` lint rule.
 *
 * A blocked-by-config run (its current stage removed from the def) → `lint` reports
 * it; a malformed/corrupt run record → reported; a healthy run / a project with no
 * runs → NO workflow-run findings (parity preserved — the default lint output is
 * unchanged when there are no workflow runs).
 */

import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  buildWorkflowProfile,
  installWorkflowProfile,
  ADAPT_BUILD_STAGES,
  ADAPT_REMOVED_STAGES,
} from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { checkWorkflowRunHealth } from "../src/linter/workflow-run-rule.js";
import { lint } from "../src/linter/index.js";

/** The findings emitted by the workflow-run rule alone. */
async function runRuleFindings(root: string): Promise<string[]> {
  return (await checkWorkflowRunHealth(root)).map((f) => f.message);
}

describe("workflow-run-health lint rule", () => {
  it("reports a blocked-by-config run (its current stage removed from the def)", async () => {
    const root = await makeTempRoot("wf-lint-blocked");
    await installWorkflowProfile(root, buildWorkflowProfile(ADAPT_BUILD_STAGES));
    await startWorkflow(root, "build", {}); // sits on `draft`
    await installWorkflowProfile(root, buildWorkflowProfile(ADAPT_REMOVED_STAGES)); // `draft` removed
    const findings = await runRuleFindings(root);
    expect(findings.some((m) => m.startsWith("run-blocked-by-config:"))).toBe(true);
  });

  it("reports a malformed/corrupt run record as a problem", async () => {
    const root = await makeTempRoot("wf-lint-corrupt");
    await installWorkflowProfile(root, buildWorkflowProfile(ADAPT_BUILD_STAGES));
    await startWorkflow(root, "build", {});
    const runsDir = path.join(root, ".llmwiki", "workflows", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(path.join(runsDir, "build-corrupt.json"), "{ not valid json", "utf8");
    const findings = await runRuleFindings(root);
    expect(findings.some((m) => m.startsWith("run-problem:"))).toBe(true);
  });

  it("emits NO workflow-run findings for a project with no runs (parity preserved)", async () => {
    const root = await makeTempRoot("wf-lint-none");
    expect(await runRuleFindings(root)).toEqual([]);
    const summary = await lint(root);
    expect(summary.results.some((r) => r.rule === "workflow-run-health")).toBe(false);
  });

  it("emits NO workflow-run findings for a healthy current run", async () => {
    const root = await makeTempRoot("wf-lint-healthy");
    await installWorkflowProfile(root, buildWorkflowProfile(ADAPT_BUILD_STAGES));
    await startWorkflow(root, "build", {});
    expect(await runRuleFindings(root)).toEqual([]);
  });
});
