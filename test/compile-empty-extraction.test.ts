/**
 * Opt-in extraction can legitimately return no wiki-worthy concepts. Exercise that
 * outcome through compilation, incremental bookkeeping and ownership changes,
 * while keeping malformed model output on the retryable failure path.
 */
import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { createWiki } from "../src/sdk/wiki.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { readState } from "../src/utils/state.js";
import { withRunNoPagesLimit } from "../src/compiler/prompt-modifiers.js";
import { reusableExtraction } from "../src/compiler/extraction-snapshot.js";
import { useReconciliationProject } from "./fixtures/reconciliation-project.js";

const EMPTY = JSON.stringify({ concepts: [] });
const TOPIC = JSON.stringify({ concepts: [
  { concept: "Batch", summary: "The documented batch.", is_new: true },
] });
const SOURCE = "# Note\n\nNo publishable details.";
const ctx = useReconciliationProject({ dirSuffix: "empty-extraction", sourceContent: SOURCE });


/** Read the previously generated page, including its orphan flag. */
async function readBatch() {
  return parseFrontmatter(await readFile(path.join(ctx.dir, "wiki/concepts/batch.md"), "utf8"));
}

describe("successful empty concept extraction", () => {
  it("keeps the default no-concepts result retryable through the SDK", async () => {
    const extract = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(EMPTY);
    const wiki = createWiki({ root: ctx.dir });
    const first = await wiki.compile({ embeddings: false });
    expect(first.errors).toContain("No concepts extracted from sample.md");
    expect((await readState(ctx.dir)).sources["sample.md"].hash).toBe("");
    await wiki.compile({ embeddings: false });
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("records a no-page success and skips the next unchanged compile", async () => {
    const extract = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(EMPTY);
    const render = vi.spyOn(AnthropicProvider.prototype, "complete");
    const first = await createWiki({ root: ctx.dir }).compile({ noPagesLimit: true, embeddings: false });
    const state = await readState(ctx.dir);
    expect(first).toMatchObject({ compiled: 1, pages: [], errors: [] });
    expect(state.sources["sample.md"].hash).not.toBe("");
    expect(state.sources["sample.md"].concepts).toEqual([]);
    expect(withRunNoPagesLimit(true, () => reusableExtraction(state.sources["sample.md"], SOURCE))).toEqual([]);
    const second = await compileAndReport(ctx.dir, { noPagesLimit: true });
    expect(second).toMatchObject({ compiled: 0, errors: [] });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
  });

  it("accepts empty output in explicit review without publishing or mutating state", async () => {
    vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(EMPTY);
    const render = vi.spyOn(AnthropicProvider.prototype, "complete");
    const result = await compileAndReport(ctx.dir, { review: true, noPagesLimit: true });
    expect(result).toMatchObject({ compiled: 1, pages: [], errors: [] });
    expect((await readState(ctx.dir)).sources["sample.md"]).toBeUndefined();
    expect(render).not.toHaveBeenCalled();
  });

  it("orphans an exclusively owned page when a valid extraction withdraws its last concept", async () => {
    const extract = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(TOPIC);
    const render = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Documented batch.");
    await compileAndReport(ctx.dir, { noPagesLimit: true });
    extract.mockResolvedValue(EMPTY);
    await writeFile(path.join(ctx.dir, "sources/sample.md"), "No longer documents a batch.");
    const result = await compileAndReport(ctx.dir, { noPagesLimit: true });
    expect(result.errors).toEqual([]);
    expect((await readBatch()).meta.orphaned).toBe(true);
    expect((await readState(ctx.dir)).sources["sample.md"].concepts).toEqual([]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a shared page from the remaining source without obsolete page context", async () => {
    const extract = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(TOPIC);
    const render = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Obsolete claim.");
    await writeFile(path.join(ctx.dir, "sources/remaining.md"), "Remaining batch evidence.");
    await compileAndReport(ctx.dir, { noPagesLimit: true });
    extract.mockImplementation(async system => system.endsWith("Withdrawn.") ? EMPTY : TOPIC);
    render.mockResolvedValue("Remaining batch evidence.^[remaining.md:1]");
    await writeFile(path.join(ctx.dir, "sources/sample.md"), "Withdrawn.");
    const result = await compileAndReport(ctx.dir, { noPagesLimit: true });
    expect(result.errors).toEqual([]);
    const page = await readBatch();
    expect(page.meta.sources).toEqual(["remaining.md"]);
    expect(page.meta.orphaned).not.toBe(true);
    expect(render.mock.calls.at(-1)?.[0]).not.toContain("Obsolete claim.");
    expect((await readState(ctx.dir)).sources["sample.md"].concepts).toEqual([]);
  });
});

describe("invalid concept extraction", () => {
  it.each([
    "not JSON", "{}", '{"concepts":null}', '{"concepts":[{}]}',
    JSON.stringify({ concepts: [{ concept: "Other", summary: "Partial result", is_new: true }, null] }),
  ])(
    "preserves ownership and retries malformed output: %s", async (invalid) => {
      const extract = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(TOPIC);
      const render = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Last good page.");
      await compileAndReport(ctx.dir, { noPagesLimit: true });
      extract.mockResolvedValue(invalid);
      await writeFile(path.join(ctx.dir, "sources/sample.md"), "Changed evidence.");
      const result = await compileAndReport(ctx.dir, { noPagesLimit: true });
      expect(result.errors).toContain("No concepts extracted from sample.md");
      const state = await readState(ctx.dir);
      expect(state.sources["sample.md"]).toMatchObject({ hash: "", concepts: ["batch"] });
      expect(state.frozenSlugs).toContain("batch");
      expect((await readBatch()).meta.orphaned).not.toBe(true);
      expect(render).toHaveBeenCalledTimes(1);
    },
  );
});
