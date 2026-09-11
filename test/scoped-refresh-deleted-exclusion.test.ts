/**
 * @file test/scoped-refresh-deleted-exclusion.test.ts
 * @description A scoped compile must not schedule a deleted source its filter
 * excluded.
 *
 * `refresh --stale` narrows compile to the sources it means to act on by
 * supplying a `changeFilter`. The affected-owner closure then runs on the
 * FILTERED list, so a deleted source the filter dropped is absent from the
 * exclusion set, looks like a live co-owner, and is appended as affected work.
 * Extraction then tries to read a file that is gone.
 *
 * The two questions are different and need different inputs: "what should this
 * run act on" is the filtered set, and "what no longer exists" is the complete
 * detection. Narrowing the first must not narrow the second.
 */

import { describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { readState } from "../src/utils/state.js";
import { mockReconciliationProvider, useReconciliationProject } from "./fixtures/reconciliation-project.js";

const ctx = useReconciliationProject({
  dirSuffix: "scoped-deleted",
  sourceFile: "a.md",
  sourceContent: "# Topic X\n\nA contributes to X.",
});

/** What b.md reports, mutable so a test can widen it between compiles. */
interface SharedOwner {
  concepts: string[];
}

/** a owns X; d owns Y; b owns whatever `bOwner` currently says. */
async function arrange(bOwner: SharedOwner): Promise<{ extractedFiles: string[] }> {
  await writeFile(path.join(ctx.dir, "sources", "b.md"), "# Topic X\n\nB contributes to X and Y.", "utf-8");
  await writeFile(path.join(ctx.dir, "sources", "d.md"), "# Topic Y\n\nD contributes to Y.", "utf-8");
  const extractedFiles: string[] = [];
  const provider = mockReconciliationProvider();
  provider.toolCall.mockImplementation(async (system) => {
    const which = system.includes("A contributes") ? "a"
      : system.includes("B contributes") ? "b"
      : system.includes("D contributes") ? "d" : "other";
    extractedFiles.push(which);
    const named = which === "b" ? bOwner.concepts
      : which === "d" ? ["Topic Y"] : ["Topic X"];
    const concepts = named.map((concept) => ({ concept, summary: "s", is_new: true }));
    return JSON.stringify({ concepts });
  });
  provider.complete.mockResolvedValue("Body. ^[b.md:1-2]");
  return { extractedFiles };
}

/** Retire both contributions by deletion or selection, then reset the probe. */
async function retireBothSources(probe: { extractedFiles: string[] }, mode: string): Promise<void> {
  if (mode === "deselected") {
    await writeFile(path.join(ctx.dir, ".llmwiki/config.json"), JSON.stringify({
      version: 1, sources: { recursive: true, exclude: ["a.md", "d.md"] },
    }));
  } else {
    await rm(path.join(ctx.dir, "sources", "a.md"));
    await rm(path.join(ctx.dir, "sources", "d.md"));
  }
  probe.extractedFiles.length = 0;
}

/**
 * Run the scoped compile that acts on a.md alone, then assert the excluded
 * deletion d.md was neither read nor retired.
 */
async function expectScopedRunSparesDeletion(
  probe: { extractedFiles: string[] },
): Promise<void> {
  const result = await compileAndReport(ctx.dir, {
    changeFilter: (change) => change.file === "a.md",
  });

  // The scoped run succeeds rather than aborting on a missing file.
  expect(result.errors).toEqual([]);
  // d.md is neither read nor extracted.
  expect(probe.extractedFiles).not.toContain("d");
  // and it stays in state, still pending for a later full compile.
  const state = await readState(ctx.dir);
  expect(Object.keys(state.sources)).toContain("d.md");
}

/** Seed the wiki, then remove both sources so only b.md survives. */
async function seedThenRetireBoth(bOwner: SharedOwner, mode: string): Promise<{ extractedFiles: string[] }> {
  const probe = await arrange(bOwner);
  await compileAndReport(ctx.dir);
  await retireBothSources(probe, mode);
  return probe;
}

describe.each(["deleted", "deselected"])("a scoped compile and a %s source the filter excluded", (mode) => {
  it("never schedules the excluded deletion, and leaves it pending", async () => {
    // b already owns Y, so the PRE-extraction closure walks a -> b -> d.
    const probe = await seedThenRetireBoth({ concepts: ["Topic X", "Topic Y"] }, mode);

    await expectScopedRunSparesDeletion(probe);
  });

  it("never schedules an excluded deletion that only late discovery reaches", async () => {
    // b starts owning X alone, so Y is genuinely NEW to it on the second run.
    // The pre-extraction closure never sees that slug; only late discovery
    // resolves its other owner, which is the excluded deletion d.md.
    const bOwner = { concepts: ["Topic X"] };
    const probe = await seedThenRetireBoth(bOwner, mode);
    bOwner.concepts = ["Topic X", "Topic Y"];

    await expectScopedRunSparesDeletion(probe);
  });

  it("still processes every deletion on an ordinary unscoped compile", async () => {
    await seedThenRetireBoth({ concepts: ["Topic X", "Topic Y"] }, mode);

    await compileAndReport(ctx.dir);

    const state = await readState(ctx.dir);
    expect(Object.keys(state.sources)).not.toContain("a.md");
    expect(Object.keys(state.sources)).not.toContain("d.md");
    if (mode === "deselected") {
      expect(await readFile(path.join(ctx.dir, "sources/d.md"), "utf8")).toContain("D contributes");
    }
  });
});
