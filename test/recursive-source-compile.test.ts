/** Recursive selection must survive real compilation, retirement and reselection. */
import { beforeEach, expect, it, vi } from "vitest";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { readState } from "../src/utils/state.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const sourceA = "# Evidence A\n\nA_SENTINEL contributes shared and exclusive knowledge.";
const ctx = useCompileProject({ dirSuffix: "recursive-selection", sourceContent: sourceA });
const requests: string[] = [];

/** Change only source selection; source bytes remain untouched. */
async function select(exclude: string[] = []): Promise<void> {
  await writeFile(path.join(ctx.dir, ".llmwiki/config.json"), JSON.stringify({
    version: 1, sources: { recursive: true, exclude },
  }));
}

beforeEach(async () => {
  requests.length = 0;
  await mkdir(path.join(ctx.dir, "sources/a"));
  await mkdir(path.join(ctx.dir, "sources/b"));
  await rename(path.join(ctx.dir, "sources/sample.md"), path.join(ctx.dir, "sources/a/notes.md"));
  await writeFile(path.join(ctx.dir, "sources/b/notes.md"), "# Evidence B\n\nB_SENTINEL shared knowledge.");
  await select();
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async (system) => {
    requests.push(system);
    const names = system.includes("A_SENTINEL") ? ["Shared Topic", "Exclusive Topic"] : ["Shared Topic"];
    return JSON.stringify({ concepts: names.map((concept) => ({ concept, summary: "Evidence summary.", is_new: true })) });
  });
  vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(async (system) => {
    requests.push(system);
    return "Evidence-based claim. ^[a/notes.md:1-2, b/notes.md:1-2]";
  });
  vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({ embedded: [], eligible: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

/** Inspect the durable page, not the provider's unvalidated response. */
async function page(slug: string) {
  return parseFrontmatter(await readFile(path.join(ctx.dir, "wiki/concepts", `${slug}.md`), "utf8"));
}

it("retires deselected contributions without deleting files and recompiles on reselection", async () => {
  expect((await compileAndReport(ctx.dir)).errors).toEqual([]);
  expect(Object.keys((await readState(ctx.dir)).sources).sort()).toEqual(["a/notes.md", "b/notes.md"]);
  expect((await page("shared-topic")).meta.sources).toEqual(["a/notes.md", "b/notes.md"]);
  requests.length = 0;
  await select(["a"]);
  expect((await compileAndReport(ctx.dir)).errors).toEqual([]);
  expect(await readFile(path.join(ctx.dir, "sources/a/notes.md"), "utf8")).toBe(sourceA);
  expect(Object.keys((await readState(ctx.dir)).sources)).toEqual(["b/notes.md"]);
  expect((await page("exclusive-topic")).meta.orphaned).toBe(true);
  const shared = await page("shared-topic");
  expect(shared.meta.sources).toEqual(["b/notes.md"]);
  expect(shared.body).toContain("^[b/notes.md:1-2]");
  expect(shared.body).not.toContain("a/notes.md");
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.join("\n")).not.toContain("A_SENTINEL");
  requests.length = 0;
  await select();
  expect((await compileAndReport(ctx.dir)).errors).toEqual([]);
  expect(requests.join("\n")).toContain("A_SENTINEL");
  expect((await readState(ctx.dir)).sources["a/notes.md"].concepts).toContain("exclusive-topic");
  expect((await page("exclusive-topic")).meta.orphaned).not.toBe(true);
});
