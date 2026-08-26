/**
 * @file test/compile-deletion-owner-closure.test.ts
 * @description End-to-end coverage for rebuilding the full live co-owner graph
 * after a shared source is deleted.
 */

import { describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { readState } from "../src/utils/state.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import {
  conceptResponse,
  stubOwnerClosureProvider,
} from "./fixtures/owner-closure-provider.js";

const ctx = useCompileProject({
  dirSuffix: "delete-owner-closure",
  sourceFile: "a.md",
  sourceContent: "# X\n\nA contributes to X.",
});

/** Return concepts according to the source text in the extraction prompt. */
function extractionFor(system: string): string {
  if (system.includes("B contributes to X and Y.")) return conceptResponse("X", "Y");
  if (system.includes("C contributes to Y.")) return conceptResponse("Y");
  return conceptResponse("X");
}

describe("deletion owner closure", () => {
  it("preserves every live owner across a transitive shared-concept chain", async () => {
    await writeFile(
      path.join(ctx.dir, "sources", "b.md"),
      "# X and Y\n\nB contributes to X and Y.",
      "utf-8",
    );
    await writeFile(
      path.join(ctx.dir, "sources", "c.md"),
      "# Y\n\nC contributes to Y.",
      "utf-8",
    );
    const systems = stubOwnerClosureProvider(extractionFor);

    await compileAndReport(ctx.dir);
    systems.length = 0;
    await rm(path.join(ctx.dir, "sources", "a.md"));
    await compileAndReport(ctx.dir);

    const x = parseFrontmatter(
      await readFile(path.join(ctx.dir, "wiki", "concepts", "x.md"), "utf-8"),
    );
    const y = parseFrontmatter(
      await readFile(path.join(ctx.dir, "wiki", "concepts", "y.md"), "utf-8"),
    );
    const state = await readState(ctx.dir);
    expect(systems).toHaveLength(2);
    expect(x.meta.sources).toEqual(["b.md"]);
    expect(y.meta.sources).toEqual(["b.md", "c.md"]);
    expect(state.sources["a.md"]).toBeUndefined();
  });
});
