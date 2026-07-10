/**
 * @file test/research-workflow-denial-cli.test.ts
 * @description The G1 relation-precondition proofs (CLP 6.3), driven end-to-end
 * through the real `dist/cli.js` in subprocesses.
 *
 * Three proofs, all over the same workflows the headline drives:
 *  - EXPERIMENT DENIAL: the research pipeline with `link-experiment` writing a
 *    `tests` edge to a NONEXISTENT idea slug. The dangling edge does NOT count
 *    toward the `experiments.complete` precondition (it resolves to no on-disk
 *    page), so `complete-experiment`'s submit is HARD-DENIED — the CLI exits
 *    non-zero, the run ends terminal `failed`, and the experiment never leaves
 *    `stage: running`.
 *  - MANUSCRIPT HAPPY: a manuscript whose `cites` edge points at a real SEEDED
 *    paper reaches `submitted`.
 *  - MANUSCRIPT DENIAL: a manuscript whose `cites` edge is dangling is HARD-DENIED
 *    at `submit-manuscript` (non-zero exit; page never reaches `submitted`).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installResearchProfile, buildResearchProject } from "./fixtures/research-profile.js";
import {
  driveResearchToComplete,
  driveManuscriptWritingToSubmit,
  driveStage,
  completeExperimentSubmit,
  submitManuscriptSubmit,
  expectManuscriptSubmitDenied,
  entityPagePath,
  expectCompleted,
  RESEARCH_GRANT,
  EXPERIMENT_SLUG,
  MANUSCRIPT_SLUG,
  SEEDED_PAPER_SLUG,
} from "./fixtures/research-workflow.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "research-workflow-denial-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("research workflow — experiment G1 denial (dangling tests edge)", () => {
  it("hard-denies complete-experiment and ends the run failed with the experiment still running", async () => {
    await installResearchProfile(root);
    const runId = await driveResearchToComplete(root, RESEARCH_GRANT, "no-such-idea");

    // Park on complete-experiment, then submit the terminal transition — G1 denies it.
    expect((await runCLI(["workflow", "advance", runId], root, RESEARCH_GRANT)).code).toBe(0);
    const denied = await runCLI(await completeExperimentSubmit(root, runId), root, RESEARCH_GRANT);
    expect(denied.code).not.toBe(0);
    // Pin the denial to the G1 RELATION precondition specifically (not an evidence/FSM
    // denial): the terminal submit supplies `resultSummary`, so only the unmet
    // `tests`→idea precondition can fail it.
    expect(denied.stderr).toMatch(/relation preconditions unmet: tests\[from\]/);

    const status = await runCLI(["workflow", "status", runId], root, RESEARCH_GRANT);
    expect(status.stdout).toMatch(/failed/i);
    const experiment = await readFile(entityPagePath(root, "experiments", EXPERIMENT_SLUG), "utf8");
    expect(experiment).toMatch(/stage:\s*running/);
  });
});

describe("manuscript workflow — citation proof", () => {
  it("reaches submitted when it cites a real seeded paper", async () => {
    await buildResearchProject(root);
    const runId = await driveManuscriptWritingToSubmit(root, RESEARCH_GRANT, SEEDED_PAPER_SLUG);
    const done = await driveStage(root, runId, await submitManuscriptSubmit(root, runId), RESEARCH_GRANT);
    expectCompleted(done);
    const manuscript = await readFile(entityPagePath(root, "manuscripts", MANUSCRIPT_SLUG), "utf8");
    expect(manuscript).toMatch(/stage:\s*submitted/);
  });

  it("is hard-denied at submit-manuscript when its cites edge is dangling", async () => {
    await buildResearchProject(root);
    const runId = await driveManuscriptWritingToSubmit(root, RESEARCH_GRANT, "no-such-paper");
    // Pins the denial to the G1 `cites`→papers precondition (submitted needs no evidence).
    await expectManuscriptSubmitDenied(root, runId, RESEARCH_GRANT);
  });
});
