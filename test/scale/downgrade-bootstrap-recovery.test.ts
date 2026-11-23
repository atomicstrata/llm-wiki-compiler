/**
 * @file test/scale/downgrade-bootstrap-recovery.test.ts
 * @description Recovery of a scale-down whose bootstrap intent outlived it
 * while the scale record moved on, on real disk, each step in its own child
 * process.
 *
 * A child applying the plan EXITS right after its intent is durable, before
 * the fence record is written. The intent alone blocks nothing, so an
 * ordinary `scale set` (the same indexed estimate) then writes a new record
 * revision, the very revision the old plan would have fenced at.
 * - STALE: applying the OLD plan refuses as stale (`scale_downgrade_stale_plan`)
 *   and retires its intent into its evidence directory (moved, never
 *   deleted), rather than fault part-way and leave the intent blocking every
 *   later scale-down. A NEW preview and apply then complete with the logical
 *   content unchanged, and only the completed scale-down is listed.
 * - NOT PROVABLY STALE: when the evidence directory also holds anything but
 *   its plan (here an attempt directory, as a fenced scale-down's staging
 *   would leave), the fence may have been written, so the old plan's apply
 *   stays a partial fault and every file is kept: the intent in place, the
 *   evidence untouched, the indexed layout in place. Unknown evidence grants no
 *   pre-fence proof, so ordinary reads stay refused while that intent is live
 *   (the admission contract of downgrade-terminal-admission.test.ts).
 */

import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, crashAt, downgradeMode, expectCompleted, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

const projects = useDowngradeProjects();

/** The scale-downs' retained evidence directories, relative to the project root. */
const EVIDENCE_DIR = ".llmwiki/scale-downgrade";
/** Hex digits of the plan digest that name its evidence directory. */
const DIGEST_PREFIX_CHARS = 12;

/** The absolute evidence directory of the plan with `digest` (exactly one). */
async function evidenceDirOf(root: string, digest: string): Promise<string> {
  const dirs = (await readdir(path.join(root, EVIDENCE_DIR))).filter((name) => name.endsWith(`-${digest.slice(0, DIGEST_PREFIX_CHARS)}`));
  expect(dirs).toHaveLength(1);
  return path.join(root, EVIDENCE_DIR, dirs[0]!);
}

/** Expect the intent of the plan with `digest` retired into that plan's evidence directory, beside its plan. */
async function expectIntentRetired(root: string, digest: string): Promise<void> {
  expect(await readdir(path.join(root, ".llmwiki"))).not.toContain("scale-downgrade.json");
  expect(await readdir(await evidenceDirOf(root, digest))).toEqual(expect.arrayContaining(["plan.json", "intent.json"]));
}

/** Build a project, save the old plan, kill its apply after the intent, then move the record on with `scale set`; returns the snapshot before and the old digest. */
async function interruptedThenSet(root: string, between?: (digest: string) => Promise<void>): Promise<{ before: Record<string, unknown>; digest: string }> {
  const before = await ok<Record<string, unknown>>("snapshot", root);
  const { digest } = await ok<{ digest: string }>("preview", root, "local-standard", "100", planFileFor(root, "old"));
  await crashAt(root, planFileFor(root, "old"), "after-intent");
  await between?.(digest);
  expect(await ok("reupgrade", root)).toBe("local-indexed");
  return { before, digest };
}

describe("a scale-down killed after its intent, before its fence", () => {
  it("is retired as stale once an ordinary scale set changed the record, and a new plan then applies", async () => {
    const root = await projects.build("build");
    const { before, digest } = await interruptedThenSet(root);
    expect((await downgradeMode("apply", root, planFileFor(root, "old"))).outcome).toBe("scale_downgrade_stale_plan");
    await expectIntentRetired(root, digest);
    const fresh = await ok<{ ready: boolean; digest: string }>("preview", root, "local-standard", "100", planFileFor(root, "new"));
    expect([fresh.ready, fresh.digest === digest]).toEqual([true, false]);
    const applied = await ok<{ resumed: boolean }>("apply", root, planFileFor(root, "new"));
    expect(applied.resumed).toBe(false);
    await expectCompleted(root, before);
    expect(await ok<unknown[]>("archives", root)).toHaveLength(1);
  }, CASE_TIMEOUT_MS);

  it("stays a partial fault, keeping every file, when its evidence directory holds more than its plan", async () => {
    const root = await projects.build("build");
    const { digest } = await interruptedThenSet(root, async (old) => { await mkdir(path.join(await evidenceDirOf(root, old), "attempt-1")); });
    expect((await downgradeMode("apply", root, planFileFor(root, "old"))).outcome).toBe("scale_downgrade_partial");
    expect(await readdir(path.join(root, ".llmwiki"))).toEqual(expect.arrayContaining(["scale-downgrade.json", "indexed"]));
    expect((await readdir(await evidenceDirOf(root, digest))).sort()).toEqual(["attempt-1", "plan.json"]);
    expect(String((await downgradeMode("snapshot", root)).outcome)).toContain("scale-downgrade-pending");
  }, CASE_TIMEOUT_MS);
});
