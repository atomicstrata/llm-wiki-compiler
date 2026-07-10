/**
 * @file test/artifact-precondition-lifecycle-transition.test.ts
 * @description Integration proof that the artifact-existence precondition is enforced
 * on the LIFECYCLE-TRANSITION write path (`transitionLifecycle` → `applyLifecycleLocked`),
 * not just on the full-page `validateLiveTypedPage` path. A transition INTO a gated
 * terminal state is DENIED when the page carries no healthy pinned artifact (missing
 * ref, or a healthy WRONG-type ref), with the on-disk page left UNCHANGED (still the
 * prior state); a healthy CORRECT ref lets the transition succeed. Before the shared
 * state-entry seam existed the two denial cases wrongly SUCCEEDED (the Critical bypass).
 */
import { describe, it, afterEach, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { ArtifactPreconditionUnmetError } from "../src/artifacts/enforce-precondition.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import { seedArtifact } from "./fixtures/artifact-seed.js";
import {
  researchArtifactPreconditionProfile, multiTypeArtifactPreconditionProfile,
  RESEARCH_ARTIFACT_TYPE, RESEARCH_ARTIFACT_FILE, OTHER_ARTIFACT_TYPE, OTHER_ARTIFACT_FILE,
} from "./fixtures/artifact-precondition-profiles.js";

/** Seed an `experiments/exp` page live in the ungated `running` state, carrying `resultLine`. */
async function seedRunningPage(root: string, resultLine: string): Promise<string> {
  const dir = path.join(root, "wiki/experiments");
  await mkdir(dir, { recursive: true });
  const front = `title: An Experiment\nstage: running${resultLine ? `\n${resultLine}` : ""}`;
  const page = path.join(dir, "exp.md");
  await writeFile(page, `---\n${front}\n---\n\nExperiment body prose here for the lint floor.\n`, "utf8");
  return page;
}

/** Assert transitioning `exp` into `complete` is DENIED (hard) and leaves the page in `running`. */
async function expectDeniedUnchanged(root: string, page: string): Promise<void> {
  await expect(transitionLifecycle(root, "experiments", "exp", "complete"))
    .rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  expect(await readFile(page, "utf8")).toMatch(/stage: running/);
}

describe("artifact precondition on the lifecycle-transition write path", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("DENIES a transition into complete with NO pinned artifact, page unchanged", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-precond-trans-"));
    await writeProfileFile(root, researchArtifactPreconditionProfile());
    const page = await seedRunningPage(root, "");
    await expectDeniedUnchanged(root, page);
  });

  it("DENIES a transition into complete pinning a healthy WRONG-type artifact, page unchanged", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-precond-trans-"));
    await writeProfileFile(root, multiTypeArtifactPreconditionProfile());
    const wrongRef = await seedArtifact(root, OTHER_ARTIFACT_TYPE, OTHER_ARTIFACT_FILE, "exp", "just a note", "text");
    const page = await seedRunningPage(root, `result: "${wrongRef}"`);
    await expectDeniedUnchanged(root, page);
  });

  it("SUCCEEDS a transition into complete with a healthy CORRECT-type artifact", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-precond-trans-"));
    await writeProfileFile(root, researchArtifactPreconditionProfile());
    const ref = await seedArtifact(root, RESEARCH_ARTIFACT_TYPE, RESEARCH_ARTIFACT_FILE, "exp", `{"accuracy":0.9}`, "json");
    const page = await seedRunningPage(root, `result: "${ref}"`);
    await transitionLifecycle(root, "experiments", "exp", "complete");
    expect(await readFile(page, "utf8")).toMatch(/stage: complete/);
  });
});
