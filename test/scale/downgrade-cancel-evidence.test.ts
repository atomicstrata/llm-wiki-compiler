/**
 * @file test/scale/downgrade-cancel-evidence.test.ts
 * @description Witnesses of the cancel's strict, confined evidence reading
 * (Root correction 3): the evidence directory is listed in full and unknown
 * names or kinds refuse; `plan.json` must be exactly the held plan; a stage
 * manifest is read for its own attempt number and must match the plan
 * (`assertStageMatchesPlan`); staged files must sit at a unit's staged path;
 * at most one attempt is complete and it is the latest; and a complete
 * attempt's staged object must still be where staging left it. DURABLE: the
 * fixture writes the plan leaf, intent and stage manifests with the product's
 * fsync writers (checkpoint 14's run timed out on it).
 */

import { rename, rmdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { stagingEvidence } from "../../src/scale/downgrade-cancel-evidence.js";
import { identityAt } from "../../src/scale/downgrade-fs.js";
import { recordStage, stagedPath } from "../../src/scale/downgrade-journal.js";
import { cancelProject, plant, refusalCodeOf, type CancelProject } from "./cancel-helpers.js";

let project: CancelProject;
beforeEach(async () => { project = await cancelProject({ bootstrapped: true }); });
// Guarded: a timed-out beforeEach leaves no project, and that must not raise a second, misleading error.
afterEach(async () => { await project?.remove(); });

/** Stage the plan's one unit as attempt `attempt`, optionally completing it with a stage manifest. */
async function stage(attempt: number, options: { complete?: boolean; units?: "plan" | "other" } = {}): Promise<void> {
  const unit = project.plan.inventory.units[0]!;
  const staged = stagedPath(project.dir, attempt, unit.relPath);
  await plant(project.root, staged, "staged bytes");
  if (options.complete !== true) return;
  const identity = await identityAt(project.root, staged);
  const units = [{ ...unit, sha256: options.units === "other" ? "b".repeat(64) : unit.sha256, staged: identity }];
  const priors = project.plan.inventory.priors.map((prior) => ({ relPath: prior.relPath, sha256: prior.sha256, identity: null }));
  await recordStage(project.root, project.dir, { plan: project.plan.digest, attempt, units, priors });
}

/** The refusal code of one call, or "accepted". */
const codeOf = refusalCodeOf;

describe("the evidence directory is read in full and strictly", () => {
  it("accepts a plan-only directory and a single complete latest attempt", async () => {
    expect(await stagingEvidence(project.root, project.dir, project.plan, [])).toBeNull();
    await stage(1);
    await stage(2, { complete: true });
    expect((await stagingEvidence(project.root, project.dir, project.plan, []))?.attempt).toBe(2);
  });

  it("refuses an unknown file, a symbolic link, and a cancel leaf the caller did not expect", async () => {
    await plant(project.root, path.posix.join(project.dir, "notes.txt"), "x");
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_not_cancellable");
    await unlink(path.join(project.root, project.dir, "notes.txt"));
    await symlink("plan.json", path.join(project.root, project.dir, "cancel.json"));
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, ["cancel.json"]))).toBe("scale_downgrade_not_cancellable");
  });

  it("refuses a plan leaf that is not exactly the held plan", async () => {
    await plant(project.root, path.posix.join(project.dir, "plan.json"), "{}");
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_not_cancellable");
  });
});

describe("staging attempts are bound to the plan, their number and their paths", () => {
  it("refuses a staged file outside the plan's unit paths", async () => {
    await plant(project.root, stagedPath(project.dir, 1, "wiki/other.md"), "x");
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_not_cancellable");
  });

  it("refuses a stage manifest whose units are not the plan's", async () => {
    await stage(1, { complete: true, units: "other" });
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_not_cancellable");
  });

  it("refuses a stage manifest that records another attempt number", async () => {
    await stage(2, { complete: true });
    const at = (attempt: number) => path.join(project.root, project.dir, `attempt-${attempt}`);
    await stage(1);
    await rename(path.join(at(2), "stage.json"), path.join(at(1), "stage.json"));
    await unlink(path.join(project.root, stagedPath(project.dir, 2, project.plan.inventory.units[0]!.relPath)));
    for (const dir of ["staged/wiki/graph", "staged/wiki", "staged", ""]) await rmdir(path.join(at(2), dir));
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_partial");
  });

  it("refuses an attempt after the complete one, and two complete attempts", async () => {
    await stage(1, { complete: true });
    await stage(2);
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_not_cancellable");
    await stage(2, { complete: true });
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_not_cancellable");
  });

  it("refuses a complete attempt whose staged object moved (installation may have begun)", async () => {
    await stage(1, { complete: true });
    const staged = stagedPath(project.dir, 1, project.plan.inventory.units[0]!.relPath);
    await rename(path.join(project.root, staged), path.join(project.root, `${staged}.moved`));
    expect(await codeOf(stagingEvidence(project.root, project.dir, project.plan, []))).toBe("scale_downgrade_not_cancellable");
  });
});
