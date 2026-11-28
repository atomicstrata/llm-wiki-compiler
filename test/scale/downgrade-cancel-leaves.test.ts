/**
 * @file test/scale/downgrade-cancel-leaves.test.ts
 * @description Witnesses that the cancel's own leaves are strict and bound:
 * the cancel intent and receipt are closed formats tied to the plan (an extra
 * key, a phase whose revisions disagree, or another plan refuses), and a
 * receipt that exists but is not bound to the exact cancel-intent bytes makes
 * the cancel refuse instead of treating the cancel as done. DURABLE: each
 * case first runs a complete bootstrapped cancel, which writes with fsync.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { cancelScaleDowngrade } from "../../src/scale/downgrade-cancel.js";
import { readCancelIntent, readCancelReceipt } from "../../src/scale/downgrade-journal.js";
import { cancelProject, refusalCodeOf, type CancelProject } from "./cancel-helpers.js";

let project: CancelProject;
beforeEach(async () => { project = await cancelProject({ bootstrapped: true }); });
// Guarded: a timed-out beforeEach leaves no project, and that must not raise a second, misleading error.
afterEach(async () => { await project?.remove(); });

/** The refusal code of one call, or "accepted". */
const codeOf = refusalCodeOf;

/** Rewrite one cancel leaf's JSON in place through `edit`. */
async function editLeaf(leaf: string, edit: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const file = path.join(project.root, project.dir, leaf);
  await writeFile(file, `${JSON.stringify(edit(JSON.parse(await readFile(file, "utf8"))))}\n`);
}

describe("the cancel leaves are closed and bound to the plan", () => {
  beforeEach(async () => { await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true }); });

  it("reads back what the cancel wrote", async () => {
    expect((await readCancelIntent(project.root, project.dir, project.plan.digest))?.phase).toBe("bootstrapped");
    expect((await readCancelReceipt(project.root, project.dir, project.plan.digest))?.estimate).toBe("unchanged");
  });

  it.each<[string, string, (value: Record<string, unknown>) => Record<string, unknown>]>([
    ["an extra key in the intent", "cancel.json", (value) => ({ ...value, extra: 1 })],
    ["a bootstrapped intent naming a cancel revision", "cancel.json", (value) => ({ ...value, cancelRevision: 4 })],
    ["an intent for another plan", "cancel.json", (value) => ({ ...value, plan: "c".repeat(64) })],
    ["a receipt with another estimate", "cancel-receipt.json", (value) => ({ ...value, estimate: "restored" })],
  ])("refuses %s", async (_label, leaf, edit) => {
    await editLeaf(leaf, edit);
    const reader = leaf === "cancel.json" ? readCancelIntent : readCancelReceipt;
    expect(await codeOf(reader(project.root, project.dir, project.plan.digest))).toBe("scale_downgrade_partial");
  });

  it("does not treat a receipt bound to other cancel-intent bytes as done", async () => {
    await editLeaf("cancel-receipt.json", (value) => ({ ...value, cancelIntentSha256: "d".repeat(64) }));
    expect(await codeOf(cancelScaleDowngrade(project.root, project.plan, { readersOffline: true }))).toBe("scale_downgrade_partial");
  });
});
