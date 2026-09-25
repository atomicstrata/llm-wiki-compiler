/**
 * @file test/compile-late-owner-closure.test.ts
 * @description End-to-end coverage for fixed-point discovery when a new source
 * reveals an owner whose extraction reveals another shared owner.
 */

import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { readState, writeState } from "../src/utils/state.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import {
  conceptResponse,
  stubOwnerClosureProvider,
} from "./fixtures/owner-closure-provider.js";

const ctx = useCompileProject({
  dirSuffix: "late-owner-closure",
  sourceFile: "b.md",
  sourceContent: "# X\n\nB contributes to X and later reveals Y.",
});

/** Return concepts for the source content embedded in an extraction prompt. */
function extractionFor(system: string, expanded: boolean): string {
  if (system.includes("D contributes to Y.")) return conceptResponse("Y");
  if (system.includes("New source contributes to X.")) return conceptResponse("X");
  return expanded ? conceptResponse("X", "Y") : conceptResponse("X");
}

describe("late owner discovery", () => {
  it.each([false, true])("preserves fixed-point discovery on cache misses (snapshots: %s)", async (snapshots) => {
    await writeFile(
      path.join(ctx.dir, "sources", "d.md"),
      "# Y\n\nD contributes to Y.",
      "utf-8",
    );
    let expanded = false;
    const systems = stubOwnerClosureProvider(
      (system) => extractionFor(system, expanded),
    );

    await compileAndReport(ctx.dir);
    if (!snapshots) {
      const state = await readState(ctx.dir);
      for (const entry of Object.values(state.sources)) delete entry.extraction;
      await writeState(ctx.dir, state);
    }
    expanded = true;
    systems.length = 0;
    await writeFile(
      path.join(ctx.dir, "sources", "new.md"),
      "# X\n\nNew source contributes to X.",
      "utf-8",
    );
    await compileAndReport(ctx.dir);

    const y = parseFrontmatter(
      await readFile(path.join(ctx.dir, "wiki", "concepts", "y.md"), "utf-8"),
    );
    expect(systems.filter((system) => system.includes("--- SOURCE DOCUMENT ---")))
      .toHaveLength(snapshots ? 1 : 3);
    // Cached assignments are stable, but a legacy/cache-miss source still
    // discovers Y and must pull D into the batch before generating that page.
    expect(y.meta.sources).toEqual(snapshots ? ["d.md"] : ["b.md", "d.md"]);
  });
});
