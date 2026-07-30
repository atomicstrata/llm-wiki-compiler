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
  it("continues extracting newly discovered owners until the graph is stable", async () => {
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
      .toHaveLength(3);
    expect(y.meta.sources).toEqual(["b.md", "d.md"]);
  });
});
