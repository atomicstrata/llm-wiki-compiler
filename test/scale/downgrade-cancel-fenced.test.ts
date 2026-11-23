/**
 * @file test/scale/downgrade-cancel-fenced.test.ts
 * @description DURABLE witnesses of the FENCED pre-install cancel on a REAL
 * indexed project, through the existing scale-down child fixture (Root
 * reviews of checkpoints 14 and 15, item 4): a scale-down is killed right
 * after its fence (nothing staged or moved), then cancelled in a fresh
 * process whose `cancel:after-intent` seam changes a file after the durable
 * cancel intent and before the record step.
 *
 * - Changing AUTHORITY evidence there (the catalog store's manifest bytes)
 *   must refuse `scale_downgrade_not_cancellable` with the scale record's
 *   exact BYTES unchanged (the fence stays; no record transition).
 * - Changing a file OUTSIDE the export and authority targets (a source) must
 *   be allowed: the cancel completes, the fence is replaced by the incumbent
 *   indexed record with nothing pending, and the edit is preserved.
 * Each case builds a real indexed project (multi-minute fsync-bound builds):
 * it runs only under the quiet-storage admission.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, crashAt, downgradeMode, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

const projects = useDowngradeProjects();

/** The scale record of `root` as JSON. */
async function recordOf(root: string): Promise<{ revision: number; pending: { kind: string } | null; active: { architecture: string } }> {
  return JSON.parse(await readFile(path.join(root, ".llmwiki", "scale.json"), "utf8"));
}

/** A real indexed project with a scale-down killed right after its fence; returns its root. */
async function fencedProject(): Promise<string> {
  const root = await projects.build("build");
  await ok("preview", root, "local-standard", "100", planFileFor(root));
  await crashAt(root, planFileFor(root), "after-fence");
  expect((await recordOf(root)).pending?.kind).toBe("downgrade");
  return root;
}

describe("a fenced cancel whose authority evidence changes after its cancel intent", () => {
  it("refuses before the record step, leaving the fence", async () => {
    const root = await fencedProject();
    const recordFile = path.join(root, ".llmwiki", "scale.json");
    const fenceBytes = await readFile(recordFile);
    const refused = await downgradeMode("cancel", root, planFileFor(root), "mutate", "authority");
    expect(refused.outcome).toBe("scale_downgrade_not_cancellable");
    expect((await readFile(recordFile)).equals(fenceBytes)).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe("a fenced cancel with an edit only outside the export and authority targets", () => {
  it("completes, keeps the incumbent indexed layout and preserves the edit", async () => {
    const root = await fencedProject();
    const result = await ok<{ phase: string; estimate: string }>("cancel", root, planFileFor(root), "mutate", "outside");
    expect([result.phase, result.estimate]).toEqual(["fenced", "planned-kept"]);
    const record = await recordOf(root);
    expect([record.pending, record.active.architecture]).toEqual([null, "local-indexed"]);
    expect(await readFile(path.join(root, "sources", "src-00000.md"), "utf8")).toContain("An edit outside the export targets.");
  }, CASE_TIMEOUT_MS);
});
