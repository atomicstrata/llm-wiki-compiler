/**
 * @file test/reset-plan.test.ts
 * @description The scoped reset PLAN (AS-1 §4.8): every file a scope would
 * destroy, named before anything is destroyed.
 *
 * THE PLAN IS THE SAFETY PROPERTY. §4.8 pins that the preview names every
 * affected file, so a scope that under-reports is worse than one that refuses:
 * the file the operator was never shown is exactly the one they would have
 * objected to. These cases therefore assert the COMPLETE list per scope, not
 * that some expected file appears in it.
 *
 * `all` IS DERIVED, NOT LISTED, so a scope added to the table is automatically
 * covered by it. The case below pins that relationship rather than a literal
 * union, which is what would rot the first time a scope is added.
 *
 * NOTHING HERE DELETES ANYTHING — planning is read-only, and the suite asserts
 * that too, because a "preview" that removed a file would be the worst possible
 * defect in this surface.
 */

import { mkdir, writeFile, symlink, readdir, rm, rename, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeReset, planReset, RESET_SCOPES } from "../src/commands/reset-plan.js";
import { tempRootTracker } from "./temp-roots.js";

const tracker = tempRootTracker();
afterEach(() => tracker.cleanup());

/** A project with one file in each scope's territory. */
async function populatedProject(): Promise<string> {
  const root = await tracker.create("reset-plan-", { real: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, "raw"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki", "runs", "prr_1"), { recursive: true });
  await writeFile(path.join(root, "wiki", "concepts", "alpha.md"), "a", "utf8");
  await writeFile(path.join(root, "raw", "source.txt"), "s", "utf8");
  await writeFile(path.join(root, "log.md"), "l", "utf8");
  await writeFile(path.join(root, ".llmwiki", "state.json"), "{}", "utf8");
  await writeFile(path.join(root, ".llmwiki", "runs", "prr_1", "run.json"), "{}", "utf8");
  return root;
}

/** The planned file list for one scope, or a thrown assertion. */
async function planned_(root: string, scope: Parameters<typeof planReset>[1]): Promise<readonly string[]> {
  const plan = await planReset(root, scope);
  if (plan.status !== "planned") throw new Error(`unplanned: ${JSON.stringify(plan)}`);
  return plan.files;
}

describe("each scope names exactly its own files", () => {
  it("refuses a parent redirected outside the project after preview", async () => {
    const root = await populatedProject();
    const outside = await tracker.create("reset-outside-", { real: true });
    await writeFile(path.join(outside, "alpha.md"), "must survive");
    const plan = await planReset(root, "wiki");
    await rename(path.join(root, "wiki", "concepts"), path.join(root, "wiki", "original"));
    await symlink(outside, path.join(root, "wiki", "concepts"));
    expect((await executeReset(root, "wiki", plan)).status).toBe("refused");
    expect(await readFile(path.join(outside, "alpha.md"), "utf8")).toBe("must survive");
  });
  it("plans the wiki scope and NOTHING else", async () => {
    const root = await populatedProject();
    expect(await planned_(root, "wiki")).toEqual([path.join("wiki", "concepts", "alpha.md")]);
  });

  it("plans the raw scope", async () => {
    const root = await populatedProject();
    expect(await planned_(root, "raw")).toEqual([path.join("raw", "source.txt")]);
  });

  it("plans the log scope", async () => {
    const root = await populatedProject();
    expect(await planned_(root, "log")).toEqual(["log.md"]);
  });

  it("plans durable run records under the checkpoints scope", async () => {
    const root = await populatedProject();
    expect(await planned_(root, "checkpoints"))
      .toEqual([path.join(".llmwiki", "runs", "prr_1", "run.json")]);
  });

  it("plans the state scope", async () => {
    const root = await populatedProject();
    expect(await planned_(root, "state")).toEqual([path.join(".llmwiki", "state.json")]);
  });
});

describe("the all scope", () => {
  it("is the union of every other scope, derived rather than listed", async () => {
    const root = await populatedProject();
    const others = RESET_SCOPES.filter((scope) => scope !== "all");
    const union = new Set((await Promise.all(others.map((scope) => planned_(root, scope)))).flat());
    // Pins the RELATIONSHIP: a scope added to the table joins `all` for free,
    // where a literal expected list would rot the first time one is added.
    expect(new Set(await planned_(root, "all"))).toEqual(union);
  });
});

describe("planning is read-only and confined", () => {
  it("removes nothing — the tree is identical after planning every scope", async () => {
    const root = await populatedProject();
    const before = (await readdir(root, { recursive: true })).sort();
    for (const scope of RESET_SCOPES) await planReset(root, scope);
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
  });

  it("REFUSES a scope root that escapes the project instead of planning it", async () => {
    const root = await tracker.create("reset-escape-", { real: true });
    const outside = await tracker.create("reset-outside-", { real: true });
    await writeFile(path.join(outside, "victim.md"), "v", "utf8");
    // A symlinked `wiki/` pointing out of the project: planning it would name —
    // and any executor would then delete — files nobody scoped.
    await symlink(outside, path.join(root, "wiki"));
    const plan = await planReset(root, "wiki");
    expect(plan.status).toBe("unavailable");
  });

  it("plans an empty list for a project with nothing in scope", async () => {
    const root = await tracker.create("reset-empty-", { real: true });
    expect(await planned_(root, "all")).toEqual([]);
  });
});

describe("executing a scoped reset", () => {
  it("deletes ONLY what the caller's plan named, not a file that appeared since", async () => {
    // The guarantee §4.8 pins: the preview names every affected file BEFORE
    // anything is destroyed. An executor that re-walked the tree would destroy
    // this second page without the operator ever having seen it.
    const root = await populatedProject();
    const plan = await planReset(root, "wiki");
    await writeFile(path.join(root, "wiki", "concepts", "appeared.md"), "new", "utf8");
    const outcome = await executeReset(root, "wiki", plan);
    expect(outcome).toMatchObject({ status: "deleted", deleted: [path.join("wiki", "concepts", "alpha.md")] });
    expect(existsSync(path.join(root, "wiki", "concepts", "appeared.md"))).toBe(true);
  });

  it("deletes exactly the planned files and nothing else", async () => {
    const root = await populatedProject();
    const planned = await planned_(root, "wiki");
    const outcome = await executeReset(root, "wiki", await planReset(root, "wiki"));
    expect(outcome).toMatchObject({ status: "deleted", deleted: planned });
    // The complement: everything OUTSIDE the scope survives untouched.
    expect(existsSync(path.join(root, "raw", "source.txt"))).toBe(true);
    expect(existsSync(path.join(root, "log.md"))).toBe(true);
    expect(existsSync(path.join(root, ".llmwiki", "state.json"))).toBe(true);
  });

  it("REFUSES a scope that escapes the project, destroying nothing", async () => {
    const root = await tracker.create("reset-exec-escape-", { real: true });
    const outside = await tracker.create("reset-exec-outside-", { real: true });
    await writeFile(path.join(outside, "victim.md"), "v", "utf8");
    await symlink(outside, path.join(root, "wiki"));
    expect((await executeReset(root, "wiki", await planReset(root, "wiki"))).status).toBe("refused");
    // The file the symlink pointed at must still be there.
    expect(existsSync(path.join(outside, "victim.md"))).toBe(true);
  });

  it("tolerates a file that vanished between plan and delete", async () => {
    const root = await populatedProject();
    // Simulate the race: remove the only wiki file after planning would have
    // seen it. Reaching the goal state by another route is not a failure.
    const plan = await planReset(root, "wiki");
    await rm(path.join(root, "wiki", "concepts", "alpha.md"));
    const outcome = await executeReset(root, "wiki", plan);
    expect(outcome).toMatchObject({ status: "deleted", deleted: [] });
  });

  it("leaves directories in place — only files are enumerated and destroyed", async () => {
    const root = await populatedProject();
    await executeReset(root, "wiki", await planReset(root, "wiki"));
    expect(existsSync(path.join(root, "wiki", "concepts"))).toBe(true);
  });

  it("clears everything under `all`, and the project survives as a directory", async () => {
    const root = await populatedProject();
    const outcome = await executeReset(root, "all", await planReset(root, "all"));
    if (outcome.status !== "deleted") throw new Error(JSON.stringify(outcome));
    expect(outcome.deleted.length).toBeGreaterThan(0);
    expect(await planned_(root, "all")).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });
});
