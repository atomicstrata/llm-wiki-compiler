/**
 * @file test/scale/downgrade-cancel-evidence-p7.test.ts
 * @description Witnesses of two P7 evidence rules (Root review of checkpoint
 * 14, item 5), through the real `stagingEvidence` on plainly written leaves
 * (the code under test only reads): an unknown directory under `staged/`
 * refuses even when EMPTY, while an empty directory on the path to a unit's
 * staged file is accepted; and attempt names must be canonical
 * (`attempt-1` to `attempt-1000`, no leading zero). An attempt directory may
 * hold nothing but `staged/` and `stage.json`, and a staged file at a unit's
 * staged path is accepted only while it has exactly one link.
 */

import { link, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { stagingEvidence } from "../../src/scale/downgrade-cancel-evidence.js";
import { stagedPath } from "../../src/scale/downgrade-journal.js";
import { plainProject, plant, type CancelProject } from "./cancel-helpers.js";

const projects: CancelProject[] = [];
afterEach(async () => { for (const project of projects.splice(0)) await project?.remove(); });

/** A plain fixture project with the directories `dirs` (relative to its evidence directory) created empty. */
async function withDirs(dirs: readonly string[]): Promise<CancelProject> {
  const project = await plainProject();
  projects.push(project);
  for (const dir of dirs) await mkdir(path.join(project.root, project.dir, dir), { recursive: true });
  return project;
}

/** The outcome of reading one project's evidence: "none" (no complete attempt), or the refusal code. */
async function outcomeOf(project: CancelProject): Promise<string> {
  return stagingEvidence(project.root, project.dir, project.plan, []).then((manifest) => (manifest === null ? "none" : `attempt-${manifest.attempt}`), (error: { code?: string }) => error.code ?? String(error));
}

describe("directories under staged/ must lie on a unit's staged path", () => {
  it("accepts an empty directory on the path to the events unit's staged file", async () => {
    expect(await outcomeOf(await withDirs(["attempt-1/staged/wiki/graph"]))).toBe("none");
  });

  it("refuses an unknown EMPTY directory", async () => {
    expect(await outcomeOf(await withDirs(["attempt-1/staged/unexpected"]))).toBe("scale_downgrade_not_cancellable");
    expect(await outcomeOf(await withDirs(["attempt-1/staged/wiki/graph/events.jsonl.d"]))).toBe("scale_downgrade_not_cancellable");
  });
});

/** The refusal message of reading one project's evidence, or "accepted". */
async function refusalOf(project: CancelProject): Promise<string> {
  return stagingEvidence(project.root, project.dir, project.plan, []).then(() => "accepted", (error: Error) => error.message);
}

describe("an attempt directory holds only staged/ and stage.json, and staged files are single-link", () => {
  it("refuses an unexpected file in an attempt directory", async () => {
    const project = await withDirs(["attempt-1/staged"]);
    await plant(project.root, path.posix.join(project.dir, "attempt-1", "notes.txt"), "not evidence");
    expect(await refusalOf(project)).toMatch(/^scale_downgrade_not_cancellable: P7: .*attempt-1 holds an unexpected file notes\.txt; nothing was written$/u);
  });

  it("accepts a single-link staged file at a unit's staged path, and refuses it once it has a second link", async () => {
    const project = await withDirs([]);
    const unit = project.plan.inventory.units.find((entry) => entry.present)!;
    const staged = stagedPath(project.dir, 1, unit.relPath);
    await plant(project.root, staged, "staged bytes");
    expect(await refusalOf(project)).toBe("accepted");
    await link(path.join(project.root, staged), path.join(project.root, "second-link"));
    expect(await refusalOf(project)).toBe(`scale_downgrade_not_cancellable: P7: ${staged} is not a regular single-link file; nothing was written`);
  });
});

describe("attempt names are canonical", () => {
  it.each(["attempt-0", "attempt-01", "attempt-1001", "attempt-x"])("refuses %s", async (name) => {
    expect(await outcomeOf(await withDirs([name]))).toBe("scale_downgrade_not_cancellable");
  });

  it("accepts attempt-1000", async () => {
    expect(await outcomeOf(await withDirs(["attempt-1000"]))).toBe("none");
  });
});
