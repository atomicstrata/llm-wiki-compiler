/**
 * @file test/scale/downgrade-cancel-races.test.ts
 * @description DURABLE witnesses of three corrections (Root review of
 * checkpoint 14, items 2 and 3 and the cleanup follow-through). The code under
 * test takes the project lock and writes durably, so these need the
 * quiet-storage admission; they are not light.
 *
 * - APPLY RACE: an apply paused by a deterministic seam right after its entry
 *   guard, while the plan is cancelled, refuses `scale_downgrade_cancelled`
 *   inside the held lock and writes no intent and no record (no sleeps).
 * - REPLAY CLEANUP: replaying a completed cancel removes a stale barrier of
 *   THIS plan (an interruption after the intent retirement leaves one) and
 *   never another plan's.
 * - ESTIMATE: a bootstrapped cancel writes no record, so it reports the
 *   ORIGINAL estimate as current, not the plan's smaller one.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { applyScaleDowngrade } from "../../src/scale/downgrade-apply.js";
import { cancelScaleDowngrade } from "../../src/scale/downgrade-cancel.js";
import type { DowngradeSeam } from "../../src/scale/downgrade-contracts.js";
import { cancelProject, ORIGINAL_ESTIMATE, PLANNED_ESTIMATE, plainProject, plant, plantCompletedCancel, refusalCodeOf, staleBarrier, type CancelProject } from "./cancel-helpers.js";
import { DURABLE_CANCEL_CASE_TIMEOUT_MS, trackDurableCancelProjects } from "./durable-cancel-lifecycle.js";

/** Keeps a fixture project for removal after the test (the shared durable cleanup hook). */
const track = trackDurableCancelProjects();

/** Keep a fixture project for removal after the test. */
const kept = track;

/** The refusal code of one call, or "accepted". */
const codeOf = refusalCodeOf;

/** A plain project holding a COMPLETED bootstrapped cancel: cancel intent, bound receipt and the retired intent. */
async function completedCancel(): Promise<CancelProject> {
  return plantCompletedCancel(kept(await plainProject({ intent: false })));
}

describe("an apply cannot reinstall a plan cancelled after its entry guard", () => {
  it("refuses inside the held lock and writes no intent or record", async () => {
    const project = kept(await plainProject({ intent: false }));
    const record = await readFile(path.join(project.root, SCALE_RECORD_FILE), "utf8");
    const cancelNow = async (stage: DowngradeSeam) => { if (stage === "apply:after-outer-guard") await plant(project.root, path.posix.join(project.dir, "cancel.json"), "{}\n"); };
    expect(await codeOf(applyScaleDowngrade(project.root, project.plan, { readersOffline: true, seam: cancelNow }))).toBe("scale_downgrade_cancelled");
    expect(await readdir(path.join(project.root, ".llmwiki"))).not.toContain("scale-downgrade.json");
    expect(await readFile(path.join(project.root, SCALE_RECORD_FILE), "utf8")).toBe(record);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

describe("replaying a completed cancel finishes only its own stale barrier", () => {
  it("removes a stale barrier of this plan", async () => {
    const project = await completedCancel();
    await plant(project.root, ".llmwiki/indexed-retire.json", staleBarrier(project.plan.digest));
    expect((await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true })).alreadyCancelled).toBe(true);
    expect(await readdir(path.join(project.root, ".llmwiki"))).not.toContain("indexed-retire.json");
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("keeps a stale barrier of another plan", async () => {
    const project = await completedCancel();
    await plant(project.root, ".llmwiki/indexed-retire.json", staleBarrier("f".repeat(64)));
    expect((await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true })).alreadyCancelled).toBe(true);
    expect(await readdir(path.join(project.root, ".llmwiki"))).toContain("indexed-retire.json");
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

describe("a bootstrapped cancel reports the estimate actually on the record", () => {
  it("reports the original estimate, unchanged, not the plan's smaller one", async () => {
    const project = kept(await cancelProject({ bootstrapped: true }));
    const result = await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true });
    expect(result.estimate).toBe("unchanged");
    expect(result.currentEstimate).toEqual(ORIGINAL_ESTIMATE);
    expect(result.currentEstimate).not.toEqual(PLANNED_ESTIMATE);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});
