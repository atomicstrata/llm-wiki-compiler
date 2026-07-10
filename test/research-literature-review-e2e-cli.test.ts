/**
 * @file test/research-literature-review-e2e-cli.test.ts
 * @description The per-kind write-semantics proof (CLP 7.2 / F4) for the
 * literature-review pipeline, driven through the real dist/cli.js. WITH the
 * operator LLMWIKI_TRUSTED_WRITE=research grant the trust-gated `gather-paper`
 * PAGE applies + advances; WITHOUT it the page PARKS (run event only, no review
 * candidate) and the run cannot leave the stage; and a trust-gated RELATION
 * (`link-concept`) WITHOUT the grant is REFUSED outright (the run fails,
 * byte-unchanged) — never parked, since a relation has no staged-review path.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { installResearchProfile } from "./fixtures/research-profile.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import {
  startRun, driveStage, driveLiteratureReview, pageSubmitArgs,
  entityPagePath, RESEARCH_GRANT, PAPER_SLUG, CONCEPT_SLUG,
} from "./fixtures/research-workflow.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "lit-review-e2e-")); await installResearchProfile(root); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("literature-review — trusted page applies with the grant", () => {
  it("applies gather-paper and advances when LLMWIKI_TRUSTED_WRITE=research", async () => {
    const runId = await startRun(root, "literature-review", RESEARCH_GRANT);
    const stepped = await driveStage(root, runId,
      await pageSubmitArgs(root, runId, "papers", PAPER_SLUG, "title: BERT\nauthors:\n  - Devlin\nstage: imported", "BERT body."),
      RESEARCH_GRANT);
    expect(stepped.stdout).toMatch(/advanced/);
    expect(await readFile(entityPagePath(root, "papers", PAPER_SLUG), "utf8")).toMatch(/stage:\s*imported/);
  });
});

describe("literature-review — page PARKS without the grant", () => {
  it("parks gather-paper (no candidate) and cannot leave the stage", async () => {
    const runId = await startRun(root, "literature-review", {});
    expect((await runCLI(["workflow", "advance", runId], root)).stdout).toMatch(/awaiting-output/i);
    const body = path.join(root, "p.md");
    await writeFile(body, "---\ntitle: BERT\nauthors:\n  - Devlin\nstage: imported\n---\n\nBody.\n", "utf8");
    const submit = await runCLI(["workflow", "submit", runId, "--kind", "page", "--entity-type", "papers", "--slug", PAPER_SLUG, "--body-file", body], root);
    expect(submit.code).toBe(0);
    expect(submit.stdout).toMatch(/parked/i);
    // A workflow-park is NOT a staged review-candidate: no `.llmwiki/candidates`
    // item is ever created on this path (src/workflows/stage-output.ts:70), so a
    // real park writes nothing there — unlike `compile --review`, which does.
    const candidateFiles = await readdir(path.join(root, CANDIDATES_DIR)).catch(() => [] as string[]);
    expect(candidateFiles.filter((f) => f.endsWith(".json"))).toHaveLength(0);
    expect((await runCLI(["workflow", "advance", runId], root)).stdout).toMatch(/awaiting-output/i);
    await expect(readFile(entityPagePath(root, "papers", PAPER_SLUG), "utf8")).rejects.toThrow();
  });
});

describe("literature-review — trust-gated RELATION refuses without the grant", () => {
  it("refuses link-concept without the grant (run fails, no relation)", async () => {
    const runId = await driveLiteratureReview(root, RESEARCH_GRANT); // parked at link-concept
    expect((await runCLI(["workflow", "advance", runId], root, RESEARCH_GRANT)).stdout).toMatch(/awaiting-output/i);
    const rel = path.join(root, "rel.json");
    // CONCEPT_SLUG must equal the slug driveLiteratureReview pinned when it submitted
    // the extract-concept page, or this endpoint dangles and the test fails for the
    // WRONG reason (endpoint-not-found, not trust-refuse). Both share the constant.
    await writeFile(rel, JSON.stringify({ type: "introduces-concept", from: "papers/" + PAPER_SLUG, to: "research-concepts/" + CONCEPT_SLUG, attributes: {} }), "utf8");
    const submit = await runCLI(["workflow", "submit", runId, "--kind", "relation", "--output-file", rel], root, {}); // NO grant
    expect(submit.code).not.toBe(0);
    expect(submit.stdout + submit.stderr).toMatch(/trust|grant/i);
    const status = await runCLI(["workflow", "status", runId], root);
    expect(status.stdout).toMatch(/failed/i);
  });
});
