/**
 * @file test/indexed/run-retire-classify.test.ts
 * @description What a batch run retirement may retire. Only finished runs
 * other than the compile state's last run, and superseded runs with NO restart
 * publication evidence, become candidates; the last run, every superseded run
 * with any evidence (a checkpointed intent, an intent its attempt never
 * checkpointed, or an inherited row), every pinned store and the newest
 * `keepFinished` finished runs stay; an active run blocks the whole preview.
 * Every preview runs in a child (a preview reads under a reader lease).
 */

import { describe, expect, it } from "bun:test";
import type { RunRetirePreviewV1 } from "../../src/indexed/run-retire.js";
import { CASE_TIMEOUT_MS, classes, copyOf, ok, useRunsBase } from "./run-retire-helpers.js";

const base = useRunsBase({
  oldDone: ["done", "none"], supEmpty: ["superseded", "none"], supPi: ["superseded", "pi"], supRaw: ["superseded", "pi-raw"],
  supIh: ["superseded", "ih"], last: ["done", "none"], newDone: ["done", "none"],
}, "last");

/** A child preview of `root` keeping `keep` finished runs. */
const preview = (root: string, keep: number) => ok<RunRetirePreviewV1>("preview", root, String(keep));

describe("candidates and kept runs", () => {
  it("keeps the last run and every superseded run with evidence; retires the rest when nothing is kept for reports", async () => {
    const found = await preview(base().root, 0);
    expect(found.admissible, found.blockers.join("; ")).toBe(true);
    expect(classes(found, base().ids)).toEqual({
      oldDone: "candidate", supEmpty: "candidate", supPi: "unproven-superseded", supRaw: "unproven-superseded",
      supIh: "unproven-superseded", last: "last-run", newDone: "candidate",
    });
    expect([...found.reportsLost].sort()).toEqual([base().ids.oldDone, base().ids.supEmpty, base().ids.newDone].sort());
    expect(found.plan.lastRun).toBe(base().ids.last);
  }, CASE_TIMEOUT_MS);

  it("keeps the newest finished runs for their reports: all by default, the newest one with keep 1", async () => {
    const byDefault = await ok<RunRetirePreviewV1>("preview", base().root);
    expect(byDefault.retirableRuns).toBe(0);
    expect(byDefault.plan.keepFinished).toBe(10);
    const one = classes(await preview(base().root, 1), base().ids);
    expect([one.newDone, one.oldDone, one.supEmpty]).toEqual(["report-retained", "candidate", "candidate"]);
  }, CASE_TIMEOUT_MS);
});

describe("protection beyond the run's own state", () => {
  it("a pin protects its whole store", async () => {
    const project = await copyOf(base());
    await ok("pin", project.root, "keep-all");
    const found = classes(await preview(project.root, 0), project.ids);
    expect([found.oldDone, found.supEmpty, found.newDone, found.last]).toEqual(["pinned", "pinned", "pinned", "last-run"]);
  }, CASE_TIMEOUT_MS);

  it("with no last run, or one whose store is gone, a superseded run with evidence still stays", async () => {
    for (const lastRun of ["null", "0123456789ab"]) {
      const project = await copyOf(base());
      await ok("last-run", project.root, lastRun);
      const found = classes(await preview(project.root, 0), project.ids);
      expect([found.last, found.supEmpty, found.supPi, found.supRaw, found.supIh]).toEqual(["candidate", "candidate", "unproven-superseded", "unproven-superseded", "unproven-superseded"]);
    }
  }, CASE_TIMEOUT_MS);

  it("an active run blocks the whole preview", async () => {
    const project = await copyOf(base());
    await ok("run", project.root, "active", "none");
    const found = await preview(project.root, 0);
    expect(found.admissible).toBe(false);
    expect(found.blockers.join("; ")).toMatch(/is active/);
    expect(found.plan.candidates).toEqual([]);
  }, CASE_TIMEOUT_MS);
});
