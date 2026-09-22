/**
 * @file Public-default compatibility: an unrelated malformed candidate is
 * retained and skipped, not promoted into a global compile prerequisite.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { CandidateRecordMalformedError } from "../src/compiler/candidate-read.js";
import { selectCandidateEntriesForMutation } from "../src/compiler/candidate-selection.js";
import { listCandidates, writeCandidate } from "../src/compiler/candidates.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const project = useCompileProject({ dirSuffix: "candidate-preflight" });
describe("public-default candidate discovery", () => {
  it("does not let an unrelated oversized leaf block a normal candidate", async () => {
    await mkdir(path.join(project.dir, ".llmwiki", "candidates"));
    const large = "x".repeat(5 * 1024 * 1024);
    const file = path.join(project.dir, ".llmwiki", "candidates", "large.json");
    await writeFile(file, large);
    await expect(writeCandidate(project.dir, {
      title: "Small", slug: "small", summary: "", sources: [], body: "Small body",
    })).resolves.toMatchObject({ slug: "small" });
    expect(await readFile(file, "utf8")).toBe(large);
  });

  it.each([false, true])("compiles with review=%s despite an unrelated malformed candidate", async (review) => {
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(JSON.stringify({ concepts: [{
      concept: "Example", summary: "An example.", is_new: true, confidence: 0.9,
      provenance_state: "extracted", contradicted_by: [],
    }] }));
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("An example body.\n");
    await mkdir(path.join(project.dir, ".llmwiki", "candidates"));
    const malformed = path.join(project.dir, ".llmwiki", "candidates", "broken.json");
    await writeFile(malformed, "{");
    const result = await compileAndReport(project.dir, { review });
    expect(result.errors).toEqual([]);
    expect(await readFile(malformed, "utf8")).toBe("{");
    if (review) expect((await listCandidates(project.dir)).map(candidate => candidate.slug)).toEqual(["example"]);
    else expect(await readFile(path.join(project.dir, "wiki", "concepts", "example.md"), "utf8")).toContain("An example body.");
  });

  it("still refuses malformed authority when a strict operation explicitly selects it", async () => {
    await mkdir(path.join(project.dir, ".llmwiki", "candidates"));
    await writeFile(path.join(project.dir, ".llmwiki", "candidates", "broken.json"), "{");
    await expect(selectCandidateEntriesForMutation(project.dir, () => true))
      .rejects.toBeInstanceOf(CandidateRecordMalformedError);
  });
});
