/**
 * @file test/scale/downgrade-cancel-repreview.test.ts
 * @description A scale-down cancelled BEFORE its fence can be previewed and
 * applied again on the unchanged project (storage-lifecycle finding SL-1).
 *
 * A bootstrapped cancel writes no scale record, and nothing else a plan binds
 * changes, so before the fix a fresh preview reproduced the cancelled plan
 * byte for byte: the same digest, the same evidence directory (already
 * holding the cancel leaves), and `--apply` refused `scale_downgrade_cancelled`
 * every time. The plan now binds the evidence directories of completed
 * cancels (`inventory.cancelled`), so the new plan has its own digest and
 * directory, while the cancelled plan itself stays refused.
 *
 * BOUNDARY (review of draft v1): only directories named as an evidence
 * directory can be bound. A receipt-shaped leaf under any other name (here
 * `notes/`, a zero revision and upper-case hex) is ignored, so a READY preview
 * always saves a plan that parses; v1 bound such names and saved a plan the
 * schema refuses.
 *
 * DURABLE and child-process based (the shared downgrade child, one process
 * per step on a real indexed project): this file needs the quiet-storage
 * admission and uses the shared named {@link CASE_TIMEOUT_MS} budget. The
 * schema witnesses at the end only parse in memory over a plain fixture.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { buildDowngradePlan, parseDowngradePlan, serializeDowngradePlan, type DowngradePlanV1 } from "../../src/scale/downgrade-plan.js";
import { canonicalRoot } from "../../src/segments/reader-lease.js";
import { plainProject } from "./cancel-helpers.js";
import { CASE_TIMEOUT_MS, crashAt, downgradeMode, expectCompleted, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

const projects = useDowngradeProjects();

/** Hex digits of the plan digest that name its evidence directory. */
const DIGEST_PREFIX_CHARS = 12;

/** The `inventory.cancelled` of the saved plan file `planFile` (undefined when absent). */
async function cancelledOf(planFile: string): Promise<unknown> {
  return (JSON.parse(await readFile(planFile, "utf8")) as { inventory: { cancelled?: unknown } }).inventory.cancelled;
}

/** Preview a plan on `root`, kill its apply right after the intent, then cancel it; returns the snapshot before and the old digest. */
async function cancelledBeforeFence(root: string): Promise<{ before: Record<string, unknown>; digest: string }> {
  const before = await ok<Record<string, unknown>>("snapshot", root);
  const { digest } = await ok<{ digest: string }>("preview", root, "local-standard", "100", planFileFor(root, "old"));
  await crashAt(root, planFileFor(root, "old"), "after-intent");
  expect((await ok<{ phase: string }>("cancel", root, planFileFor(root, "old"))).phase).toBe("bootstrapped");
  return { before, digest };
}

describe("after a cancel before the fence, on the unchanged project", () => {
  it("previews a NEW plan binding the cancelled directory, still refuses the old plan, and applies the new one", async () => {
    const root = await projects.build("build");
    const { before, digest } = await cancelledBeforeFence(root);
    const fresh = await ok<{ ready: boolean; digest: string }>("preview", root, "local-standard", "100", planFileFor(root, "new"));
    expect([fresh.ready, fresh.digest === digest]).toEqual([true, false]);
    expect(await cancelledOf(planFileFor(root, "new"))).toEqual([expect.stringMatching(new RegExp(`^\\d+-${digest.slice(0, DIGEST_PREFIX_CHARS)}$`, "u"))]);
    expect((await downgradeMode("apply", root, planFileFor(root, "old"))).outcome).toBe("scale_downgrade_cancelled");
    expect((await ok<{ resumed: boolean }>("apply", root, planFileFor(root, "new"))).resumed).toBe(false);
    await expectCompleted(root, before);
  }, CASE_TIMEOUT_MS);
});

/** Plant a receipt-shaped leaf in the evidence-root child `name` of `root` (a plain write: only its presence matters). */
async function plantReceipt(root: string, name: string): Promise<void> {
  const dir = path.join(root, ".llmwiki", "scale-downgrade", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cancel-receipt.json"), "{}\n");
}

describe("a receipt under a name no evidence directory can have", () => {
  it("is ignored: the preview stays ready and the plan it saved parses", async () => {
    const root = await projects.build("build");
    for (const name of ["notes", "0-0123456789ab", "2-0123456789AB"]) await plantReceipt(root, name);
    const preview = await ok<{ ready: boolean; digest: string }>("preview", root, "local-standard", "100", planFileFor(root));
    const plan = parseDowngradePlan(await readFile(planFileFor(root), "utf8"), await canonicalRoot(root));
    expect([preview.ready, plan.digest === preview.digest, plan.inventory.cancelled]).toEqual([true, true, undefined]);
  }, CASE_TIMEOUT_MS);
});

/** `plan` re-built with `inventory.cancelled` set to `cancelled`, serialized as a saved plan. */
function withCancelled(plan: DowngradePlanV1, cancelled: unknown): string {
  return serializeDowngradePlan(buildDowngradePlan(plan.root, { ...plan.inventory, cancelled } as DowngradePlanV1["inventory"]));
}

describe("the plan schema's cancelled list", () => {
  it("accepts a plan without it and a sorted list of evidence directory names", async () => {
    const project = await plainProject();
    try {
      expect(parseDowngradePlan(serializeDowngradePlan(project.plan), project.root).digest).toBe(project.plan.digest);
      expect(parseDowngradePlan(withCancelled(project.plan, ["3-0123456789ab", "5-abcdef012345"]), project.root).inventory.cancelled).toHaveLength(2);
    } finally {
      await project.remove();
    }
  });

  it("refuses an empty, unsorted, duplicated or malformed list", async () => {
    const project = await plainProject();
    try {
      for (const cancelled of [[], ["5-abcdef012345", "3-0123456789ab"], ["3-0123456789ab", "3-0123456789ab"], ["../x"], ["0-0123456789ab"], "3-0123456789ab"]) {
        expect(() => parseDowngradePlan(withCancelled(project.plan, cancelled), project.root)).toThrow(/malformed/u);
      }
    } finally {
      await project.remove();
    }
  });
});
