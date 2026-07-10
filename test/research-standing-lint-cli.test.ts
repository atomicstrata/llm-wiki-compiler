/**
 * @file test/research-standing-lint-cli.test.ts
 * @description The standing relation-precondition drift detector proven at the REAL
 * `llmwiki lint` subprocess level (the project rule: every CLI-exercisable criterion
 * gets a subprocess test, not only in-process coverage). A page landed in a gated
 * lifecycle state whose relation precondition later drifts (its sole qualifying
 * endpoint moves to a disallowed state) must surface as a lint ERROR (exit 1) that
 * names the page and the shortfall; a CORRUPTED relation store fails the lint via
 * the dedicated relation-store-corrupt ERROR rule (exit 1) — the read never
 * silently passes, so a degraded store is never reported as healthy.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId } from "../src/profile/types.js";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { appendRelation } from "../src/relations/store.js";
import { RELATIONS_FILE } from "../src/utils/constants.js";
import { installResearchProfile, RESEARCH_PROFILE } from "./fixtures/research-profile.js";
import { writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import { runCLI } from "./fixtures/run-cli.js";

const EXP = "probe";
const IDEA = "target";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "standing-lint-cli-"));
  await installResearchProfile(root);
  await writeMarkdownPage(root, "wiki/experiments", EXP, "---\ntitle: Probe\nhypothesis: H.\nstage: running\n---\n\nBody.\n");
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Land the experiment at `complete` with a qualifying `validated` idea + tests edge. */
async function landComplete(): Promise<void> {
  await writeMarkdownPage(root, "wiki/ideas", IDEA, "---\ntitle: Target\nrationale: Worth it.\nstage: validated\n---\n\nBody.\n");
  await appendRelation(root, RESEARCH_PROFILE, { type: "tests", from: `experiments/${EXP}` as EntityId, to: `ideas/${IDEA}` as EntityId });
  await transitionLifecycle(root, "experiments", EXP, "complete", { resultSummary: "Confirmed." });
}

describe("standing relation drift over the real llmwiki lint CLI", () => {
  it("reports a drifted gated page as a lint ERROR naming the page + shortfall (exit 1)", async () => {
    await landComplete();
    await writeMarkdownPage(root, "wiki/ideas", IDEA, "---\ntitle: Target\nrationale: Worth it.\nstage: rejected\n---\n\nBody.\n");
    const result = await runCLI(["lint"], root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`experiments/${EXP}`);
    expect(result.stdout).toContain("no longer satisfied");
  });

  it("fails the lint (exit 1) on a corrupt relation store rather than passing silently", async () => {
    await landComplete();
    await writeFile(path.join(root, RELATIONS_FILE), '{"kind":"relation-store-header","schemaVersion":1}\nnot-a-record\n', "utf8");
    const result = await runCLI(["lint"], root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(RELATIONS_FILE);
  });
});
