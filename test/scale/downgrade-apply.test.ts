/**
 * @file test/scale/downgrade-apply.test.ts
 * @description Explicit scale-down end to end on real disk, every store-
 * opening step in its own child process.
 *
 * An active `local-indexed` project with the segmented compile state, whose
 * events, relations, workspace catalog, compile state and vectors were all
 * written before AND after activation, scales down to `local-standard`: the
 * logical content read through the ordinary routes is IDENTICAL before and
 * after; the record is version 1 with the target active; `.llmwiki/indexed`
 * and the pins moved into the retained evidence directory with the prior
 * files, the staged attempt, the receipt and the retired intent; an ordinary
 * write then works on the smaller layout. A project whose history began only
 * after activation (no incumbent graph directory) gets that directory and its
 * files created by the scale-down. A plan made stale by one write
 * refuses with nothing changed; an apply without the readers assertion
 * refuses; a lowered estimate that plans higher than the target is a blocker;
 * `local-large` scales down to `local-standard` by its record alone.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, downgradeMode, expectCompleted, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

const projects = useDowngradeProjects();

/** The entries of `relDir` under `root`, sorted, or `[]` when absent. */
async function entries(root: string, relDir: string): Promise<string[]> {
  return (await readdir(path.join(root, relDir)).catch(() => [] as string[])).sort();
}

describe("an indexed project scaling down to local-standard", () => {
  it("keeps every logical record, activates version 1 and retains the stores, priors and evidence", async () => {
    const root = await projects.build("build");
    const before = await ok<Record<string, unknown>>("snapshot", root);
    const preview = await ok<{ ready: boolean; notices: string[] }>("preview", root, "local-standard", "100", planFileFor(root));
    expect(preview.ready).toBe(true);
    expect(preview.notices).toEqual(expect.arrayContaining(["catalog_archived", "indexed_backups_unrestorable", "precision_float32", "embeddings_binary", "batch_compile_unavailable"]));
    const applied = await ok<{ dir: string; revision: number; resumed: boolean }>("apply", root, planFileFor(root));
    const after = await ok<Record<string, unknown>>("snapshot", root);
    expect({ ...after, active: undefined, version: undefined, readiness: undefined }).toEqual({ ...before, active: undefined, version: undefined, readiness: undefined });
    expect([after.active, after.version, after.readiness, applied.resumed]).toEqual(["local-standard", 1, "ready", false]);
    expect(await entries(root, ".llmwiki")).not.toContain("indexed");
    expect(await entries(root, ".llmwiki")).not.toContain("scale-downgrade.json");
    expect(await entries(root, applied.dir)).toEqual(["attempt-1", "indexed", "intent.json", "plan.json", "prior", "receipt.json", "archive.json"].sort());
    const receipt = JSON.parse(await readFile(path.join(root, applied.dir, "receipt.json"), "utf8"));
    expect(receipt.archive.stores).toEqual(await entries(root, `${applied.dir}/indexed`));
    expect(await ok("append", root)).toBeTypeOf("string");
  }, CASE_TIMEOUT_MS);
});

describe("an indexed project whose history began after activation", () => {
  it("creates the incumbent graph directory and files it never had, then activates", async () => {
    const root = await projects.build("build-late");
    expect(await entries(root, "wiki")).not.toContain("graph");
    const before = await ok<Record<string, unknown>>("snapshot", root);
    await ok("preview", root, "local-standard", "100", planFileFor(root));
    await ok("apply", root, planFileFor(root));
    await expectCompleted(root, before);
    expect(await entries(root, "wiki/graph")).toEqual(["events.jsonl", "relations.jsonl"]);
  }, CASE_TIMEOUT_MS);
});

describe("refusals", () => {
  it("refuses a plan made stale by one write, changing nothing", async () => {
    const root = await projects.build("build");
    await ok("preview", root, "local-standard", "100", planFileFor(root));
    await ok("append", root);
    expect((await downgradeMode("apply", root, planFileFor(root))).outcome).toBe("scale_downgrade_stale_plan");
    expect(await entries(root, ".llmwiki")).toEqual(expect.arrayContaining(["indexed"]));
    expect(await entries(root, ".llmwiki")).not.toContain("scale-downgrade.json");
    expect((await ok<{ active: string; readiness: string }>("snapshot", root))).toMatchObject({ active: "local-indexed", readiness: "ready" });
  }, CASE_TIMEOUT_MS);

  it("refuses without the readers assertion, and reports a lowered estimate that plans higher as a blocker", async () => {
    const root = await projects.build("build");
    await ok("preview", root, "local-standard", "100", planFileFor(root));
    expect((await downgradeMode("apply-unasserted", root, planFileFor(root))).outcome).toBe("scale_downgrade_readers_live");
    const high = await ok<{ ready: boolean; blockers: Array<{ code: string }> }>("preview", root, "local-standard", "2000", planFileFor(root, "high"));
    expect([high.ready, high.blockers.map((blocker) => blocker.code)]).toEqual([false, ["estimate_plans_higher"]]);
    expect((await downgradeMode("apply", root, planFileFor(root, "high"))).outcome).toBe("scale_downgrade_blocked");
  }, CASE_TIMEOUT_MS);
});

describe("a local-large project scaling down to local-standard", () => {
  it("changes only its record, keeping the binary embedding store authoritative", async () => {
    const root = await projects.build("large");
    const before = await ok<{ vectors: unknown }>("snapshot", root);
    expect(Object.keys(before.vectors as Record<string, unknown>)).toHaveLength(2);
    const preview = await ok<{ ready: boolean; notices: string[]; units: unknown[] }>("preview", root, "local-standard", "100", planFileFor(root));
    expect([preview.ready, preview.notices, preview.units]).toEqual([true, ["selection_only", "embeddings_binary"], []]);
    await ok("apply", root, planFileFor(root));
    const after = await ok<{ vectors: unknown; active: string; version: number }>("snapshot", root);
    expect(Object.keys(after.vectors as Record<string, unknown>)).toHaveLength(2);
    expect([after.active, after.version, after.vectors]).toEqual(["local-standard", 1, before.vectors]);
    expect(await entries(root, ".llmwiki")).toContain("embeddings.bin");
  }, CASE_TIMEOUT_MS);
});
