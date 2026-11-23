/**
 * @file test/scale/downgrade-recovery.test.ts
 * @description Recovery and retention witnesses of an indexed scale-down.
 *
 * - KILLED AFTER ACTIVATION: the visible activation stays behind the live
 *   intent (the admission contract of downgrade-terminal-admission.test.ts), so
 *   an ordinary legacy write and a `scale set` back to `local-indexed` are both
 *   refused until the next apply of the old plan resumes, completes and retires
 *   the intent into its archive; afterwards both are admitted again.
 * - SAME-PROCESS RETRY: a controlled failure after staging releases only
 *   that attempt's barrier, so the same apply in the same process resumes.
 * - RUN REPORTS: a finished batch run's report is archived; `compile
 *   --report` refuses it on the smaller layout, and the archive reader pages
 *   it with the same report reader, refusing a cursor not issued for it.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, crashAt, downgradeMode, expectCompleted, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

const projects = useDowngradeProjects();

describe("a committed scale-down killed after activation", () => {
  it("refuses ordinary writes and a re-upgrade until recovery retires its intent, then admits both", async () => {
    const root = await projects.build("build");
    const before = await ok<Record<string, unknown>>("snapshot", root);
    await ok("preview", root, "local-standard", "100", planFileFor(root));
    await crashAt(root, planFileFor(root), "after-activation");
    expect(String((await downgradeMode("append", root)).outcome)).toContain("scale-downgrade-pending");
    expect((await downgradeMode("reupgrade", root)).outcome).toBe("scale_downgrade_pending");
    const cleaned = await ok<{ resumed: boolean; dir: string }>("apply", root, planFileFor(root));
    expect(cleaned.resumed).toBe(true);
    await expectCompleted(root, before);
    expect(await readdir(path.join(root, cleaned.dir))).toEqual(expect.arrayContaining(["indexed", "receipt.json", "intent.json"]));
    const appended = await ok<string>("append", root);
    expect(await ok("reupgrade", root)).toBe("local-indexed");
    const after = await ok<{ active: string; events: Array<{ id: string }> }>("snapshot", root);
    expect(after.active).toBe("local-indexed");
    expect(after.events.map((event) => event.id)).toContain(appended);
  }, CASE_TIMEOUT_MS);
});

describe("a controlled failure in a long-lived process", () => {
  it("releases only its own barrier, so the same process resumes the same plan", async () => {
    const root = await projects.build("build");
    const before = await ok<Record<string, unknown>>("snapshot", root);
    await ok("preview", root, "local-standard", "100", planFileFor(root));
    const result = await ok<{ first: string; second: { resumed: boolean } }>("apply-fail-retry", root, planFileFor(root));
    expect([result.first, result.second.resumed]).toEqual(["scale_downgrade_partial", true]);
    await expectCompleted(root, before);
  }, CASE_TIMEOUT_MS);
});

describe("archived batch run reports", () => {
  it("are refused by compile --report on the smaller layout and paged from the archive", async () => {
    const root = await projects.build("build");
    const { runId } = await ok<{ runId: string }>("run", root);
    const preview = await ok<{ notices: string[] }>("preview", root, "local-standard", "100", planFileFor(root));
    expect(preview.notices).toContain("run_reports_archived");
    await ok("apply", root, planFileFor(root));
    expect(String((await downgradeMode("report", root, runId)).outcome)).toMatch(/^compile_batch_/);
    const [archive] = await ok<Array<{ name: string; runs: Array<{ runId: string; status: string }> }>>("archives", root);
    expect(archive!.runs).toEqual([{ runId, status: "done" }]);
    const page = await ok<{ lines: unknown[] }>("archive-report", root, archive!.name, runId);
    expect(page.lines).toEqual([{ kind: "compiled", file: "sources/src-00000.md" }]);
    expect((await downgradeMode("archive-report", root, archive!.name, runId, `r1.${runId}.0`)).outcome).toBe("scale_downgrade_archive_invalid");
  }, CASE_TIMEOUT_MS);
});
