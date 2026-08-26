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

import { describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { readState } from "../src/utils/state.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const ctx = useCompileProject({
  dirSuffix: "scoped-deleted",
  sourceFile: "a.md",
  sourceContent: "# Topic X\n\nA contributes to X.",
});

/** a owns X; b owns X and Y; d owns Y — so the closure can walk a -> b -> d. */
async function arrange(): Promise<{ extractedFiles: string[] }> {
  await writeFile(path.join(ctx.dir, "sources", "b.md"), "# Topic X\n\nB contributes to X and Y.", "utf-8");
  await writeFile(path.join(ctx.dir, "sources", "d.md"), "# Topic Y\n\nD contributes to Y.", "utf-8");
  const extractedFiles: string[] = [];
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async (system) => {
    const which = system.includes("A contributes") ? "a"
      : system.includes("B contributes") ? "b"
      : system.includes("D contributes") ? "d" : "other";
    extractedFiles.push(which);
    const concepts = which === "b"
      ? [{ concept: "Topic X", summary: "s", is_new: true }, { concept: "Topic Y", summary: "s", is_new: true }]
      : which === "d"
        ? [{ concept: "Topic Y", summary: "s", is_new: true }]
        : [{ concept: "Topic X", summary: "s", is_new: true }];
    return JSON.stringify({ concepts });
  });
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Body. ^[b.md:1-2]");
  vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({ embedded: [], eligible: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { extractedFiles };
}

/** Remove both sources from disk and reset the extraction record. */
async function deleteBothSources(probe: { extractedFiles: string[] }): Promise<void> {
  await rm(path.join(ctx.dir, "sources", "a.md"));
  await rm(path.join(ctx.dir, "sources", "d.md"));
  probe.extractedFiles.length = 0;
}

describe("a scoped compile and a deleted source the filter excluded", () => {
  it("never schedules the excluded deletion, and leaves it pending", async () => {
    const probe = await arrange();
    await compileAndReport(ctx.dir);

    // Both a.md and d.md are gone, but this run is scoped to a.md only.
    await deleteBothSources(probe);

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
  });

  it("still processes every deletion on an ordinary unscoped compile", async () => {
    const probe = await arrange();
    await compileAndReport(ctx.dir);
    await deleteBothSources(probe);

    await compileAndReport(ctx.dir);

    const state = await readState(ctx.dir);
    expect(Object.keys(state.sources)).not.toContain("a.md");
    expect(Object.keys(state.sources)).not.toContain("d.md");
  });
});
