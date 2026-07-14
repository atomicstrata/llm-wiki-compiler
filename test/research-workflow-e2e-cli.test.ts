/**
 * @file test/research-workflow-e2e-cli.test.ts
 * @description The HEADLINE end-to-end proof (CLP 6.3): the 9-stage `research`
 * workflow driven entirely through the real `dist/cli.js` in a subprocess.
 *
 * The happy path starts `research` and drives all nine stages — page creates, two
 * lifecycle transitions, a `builds-on` relation, `start-experiment`, a `tests`
 * relation, and the G1-gated `complete-experiment` transition — with the operator
 * `LLMWIKI_TRUSTED_WRITE=research` grant. It asserts the final `advance` reports
 * `completed`, the experiment page on disk sits at `stage: complete`, and both the
 * `builds-on` and `tests` relations are live. This is THE minimum-proof headline.
 *
 * A second test pins the TRUST seam: WITHOUT the grant, the sole `trust:`-gated
 * stage (`import-paper`) PARKS its page (never applies, and creates NO review
 * candidate — the CLI must say so honestly) and the run cannot leave that stage —
 * so the grant is genuinely load-bearing, not decorative.
 */

import { vi } from "vitest";
// This suite drives the whole CLI through many subprocess spawns and runs ~25s of
// subprocess work against the 30s default. vitest already caps workers because subprocess
// tests starve each other under load, so on a slower CI runner any test here can breach 30s
// with nothing broken. Raise the timeout for the whole FILE — the fix belongs at file scope,
// not on one victim test at a time. No assertion is weakened.
vi.setConfig({ testTimeout: 90_000 });
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installResearchProfile, RESEARCH_PROFILE } from "./fixtures/research-profile.js";
import { readLiveValidRelations } from "../src/relations/live-valid.js";
import {
  driveResearchToComplete,
  completeExperimentSubmit,
  driveStage,
  startRun,
  entityPagePath,
  expectCompleted,
  RESEARCH_GRANT,
  IDEA_SLUG,
  EXPERIMENT_SLUG,
  PAPER_SLUG,
} from "./fixtures/research-workflow.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "research-workflow-e2e-"));
  await installResearchProfile(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/**
 * Measured ~14-15s on an idle machine against the 30s default, so this test carries barely
 * 2x headroom. It drives the whole CLI through many subprocess spawns, and vitest already
 * caps workers because subprocess tests starve each other under load — on a slower CI runner
 * that margin disappears and the test times out with nothing actually broken. Give it the
 * headroom its measured cost demands.
 */
const SLOW_CLI_TIMEOUT_MS = 90_000;

describe("research workflow — 9-stage happy path (headline)", () => {
  it("drives all nine stages to completed, lands the experiment at stage: complete, and wires both relations", async () => {
    const runId = await driveResearchToComplete(root, RESEARCH_GRANT, IDEA_SLUG);
    const done = await driveStage(root, runId, await completeExperimentSubmit(root, runId), RESEARCH_GRANT);
    expectCompleted(done);

    const experiment = await readFile(entityPagePath(root, "experiments", EXPERIMENT_SLUG), "utf8");
    expect(experiment).toMatch(/stage:\s*complete/);

    const relations = await readLiveValidRelations(root, RESEARCH_PROFILE);
    const buildsOn = relations.find((r) => r.type === "builds-on");
    const tests = relations.find((r) => r.type === "tests");
    expect(buildsOn?.from).toBe(`ideas/${IDEA_SLUG}`);
    expect(buildsOn?.to).toBe(`papers/${PAPER_SLUG}`);
    expect(tests?.from).toBe(`experiments/${EXPERIMENT_SLUG}`);
    expect(tests?.to).toBe(`ideas/${IDEA_SLUG}`);
  }, SLOW_CLI_TIMEOUT_MS);
});

describe("research workflow — trust seam (import-paper)", () => {
  it("PARKS the trust-gated page without the grant (honestly worded), and the run cannot leave import-paper", async () => {
    const runId = await startRun(root, "research", {});
    expect((await runCLI(["workflow", "advance", runId], root)).stdout).toMatch(/awaiting-output/i);

    const bodyFile = path.join(root, "ungranted.md");
    await writeFile(bodyFile, "---\ntitle: BERT\nauthors:\n  - Devlin\nstage: imported\n---\n\nBody.\n", "utf8");
    const submit = await runCLI(["workflow", "submit", runId, "--kind", "page", "--entity-type", "papers", "--slug", PAPER_SLUG, "--body-file", bodyFile], root);
    expect(submit.code).toBe(0);
    // The output is PARKED, not applied — and NO review candidate exists on the
    // workflow path, so the CLI must not claim one ("staged for review" was a lie).
    expect(submit.stdout).toMatch(/parked/i);
    expect(submit.stdout).toMatch(/not applied/i);
    expect(submit.stdout).not.toMatch(/staged for review/i);

    const reAdvance = await runCLI(["workflow", "advance", runId], root);
    expect(reAdvance.stdout).toMatch(/awaiting-output/i);
    await expect(readFile(entityPagePath(root, "papers", PAPER_SLUG), "utf8")).rejects.toThrow();
  });
});
