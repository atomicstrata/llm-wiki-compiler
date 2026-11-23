/**
 * @file test/scale/downgrade-cancel-bootstrapped.test.ts
 * @description End-to-end witnesses of the BOOTSTRAPPED cancel (design v2 §6)
 * through the real `cancelScaleDowngrade`, plus its refusals and the apply
 * guard, on a light fixture (no indexed store, no child process): the record
 * is never written; the cancel intent, a bound receipt and the retired intent
 * are kept; a re-run reports it already cancelled; an interruption at each
 * cancel seam resumes; a cancelled plan is never applied; and every refusal
 * writes nothing. DURABLE: the fixture and the code under test write with
 * fsync, so this file needs the quiet-storage admission (checkpoint 14's run
 * timed out on it). The FENCED path (maintenance custody, compare-and-swap) is
 * not exercised here: it needs a real indexed project and stays pending.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { applyScaleDowngrade } from "../../src/scale/downgrade-apply.js";
import { cancelScaleDowngrade } from "../../src/scale/downgrade-cancel.js";
import type { DowngradeSeam } from "../../src/scale/downgrade-contracts.js";
import { cancelProject, ORIGINAL_ESTIMATE, plant, refusalCodeOf, type CancelProject } from "./cancel-helpers.js";
import { DURABLE_CANCEL_CASE_TIMEOUT_MS, trackDurableCancelProjects } from "./durable-cancel-lifecycle.js";

/** Keeps a fixture project for removal after the test (the shared durable cleanup hook). */
const track = trackDurableCancelProjects();

/** A fixture project, removed after the test. */
async function made(bootstrapped = true): Promise<CancelProject> {
  return track(await cancelProject({ bootstrapped }));
}

/** The refusal code of one call, or "accepted". */
const codeOf = refusalCodeOf;

/** A seam that throws at exactly `at`, as an interruption there would stop the cancel. */
const failAt = (at: DowngradeSeam) => async (stage: DowngradeSeam) => { if (stage === at) throw new Error(`interrupted at ${at}`); };

describe("a bootstrapped cancel", () => {
  it("retires the intent, keeps every leaf and the record bytes, and reports the estimate unchanged", async () => {
    const project = await made();
    const record = await readFile(path.join(project.root, SCALE_RECORD_FILE), "utf8");
    const result = await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true });
    expect(result).toMatchObject({ phase: "bootstrapped", cancelRevision: null, estimate: "unchanged", resumed: false, alreadyCancelled: false, laterRecord: null });
    expect(result.currentEstimate).toEqual(ORIGINAL_ESTIMATE);
    expect(await readFile(path.join(project.root, SCALE_RECORD_FILE), "utf8")).toBe(record);
    expect((await readdir(path.join(project.root, project.dir))).sort()).toEqual(["cancel-receipt.json", "cancel.json", "intent.json", "plan.json"]);
    expect(await readdir(path.join(project.root, ".llmwiki"))).not.toContain("scale-downgrade.json");
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("reports an already completed cancel without writing, and refuses to apply the cancelled plan", async () => {
    const project = await made();
    await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true });
    const again = await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true });
    expect(again.alreadyCancelled).toBe(true);
    expect(await codeOf(applyScaleDowngrade(project.root, project.plan, { readersOffline: true }))).toBe("scale_downgrade_cancelled");
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it.each<DowngradeSeam>(["cancel:after-intent", "cancel:after-receipt"])("resumes after an interruption at %s", async (seam) => {
    const project = await made();
    expect(await codeOf(cancelScaleDowngrade(project.root, project.plan, { readersOffline: true, seam: failAt(seam) }))).toMatch(/interrupted/u);
    const resumed = await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true });
    expect([resumed.resumed, resumed.alreadyCancelled]).toEqual([true, false]);
    expect(await readdir(path.join(project.root, ".llmwiki"))).not.toContain("scale-downgrade.json");
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

describe("cancel refusals write nothing", () => {
  it("refuses without the readers-offline assertion, before reading anything", async () => {
    const project = await made();
    expect(await codeOf(cancelScaleDowngrade(project.root, project.plan, { readersOffline: false }))).toBe("scale_downgrade_readers_live");
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("refuses when this plan has nothing in progress", async () => {
    const project = await made(false);
    expect(await codeOf(cancelScaleDowngrade(project.root, project.plan, { readersOffline: true }))).toBe("scale_downgrade_nothing_to_cancel");
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("refuses unknown evidence and a staging attempt, leaving no cancel leaf behind", async () => {
    for (const relPath of ["notes.txt", "attempt-1/staged/wiki/graph/events.jsonl"]) {
      const project = await made();
      await plant(project.root, path.posix.join(project.dir, relPath), "x");
      expect(await codeOf(cancelScaleDowngrade(project.root, project.plan, { readersOffline: true }))).toBe("scale_downgrade_not_cancellable");
      expect(await readdir(path.join(project.root, project.dir))).not.toContain("cancel.json");
      expect(await readdir(path.join(project.root, ".llmwiki"))).toContain("scale-downgrade.json");
    }
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});
