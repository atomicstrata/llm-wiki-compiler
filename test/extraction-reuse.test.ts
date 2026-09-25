/**
 * Incremental compiles must reuse unchanged contributors' extraction metadata
 * without omitting their evidence from shared-page generation. These tests run
 * the real compile pipeline with only the model and embeddings stubbed.
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { readState, writeState } from "../src/utils/state.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { mockReconciliationProvider, useReconciliationProject } from "./fixtures/reconciliation-project.js";

const ctx = useReconciliationProject({
  dirSuffix: "extraction-reuse", sourceFile: "alpha.md",
  sourceContent: "# Alpha\n\nAlpha evidence about the shared subject.",
});

/** Give each source a shared concept and a private concept. */
async function seed() {
  await writeFile(path.join(ctx.dir, "sources/beta.md"), "# Beta\n\nBeta evidence about the shared subject.");
  const provider = mockReconciliationProvider();
  provider.toolCall.mockImplementation(async (system) => {
    const source = system.split("--- SOURCE DOCUMENT ---")[1];
    const name = source.includes("Alpha") ? "Alpha" : source.includes("Beta") ? "Beta" : "Gamma";
    return JSON.stringify({ concepts: ["Shared", name].map((concept) => ({
      concept, summary: `${name} supports ${concept}`, is_new: true, confidence: 0.8,
    })) });
  });
  provider.complete.mockResolvedValue("Supported content about the shared subject.");
  await compileAndReport(ctx.dir);
  provider.toolCall.mockClear();
  provider.complete.mockClear();
  return provider;
}

/** Add a source without touching either existing contributor. */
async function addGamma() {
  await writeFile(path.join(ctx.dir, "sources/gamma.md"), "# Gamma\n\nGamma evidence about the shared subject.");
  return compileAndReport(ctx.dir);
}

describe("unchanged extraction reuse", () => {
  it("extracts only the new source but keeps every shared contributor", async () => {
    const provider = await seed();
    const before = await readFile(path.join(ctx.dir, "wiki/concepts/beta.md"), "utf8");
    const owner = (await readState(ctx.dir)).sources["beta.md"];
    expect((await addGamma()).errors).toEqual([]);
    expect(provider.toolCall).toHaveBeenCalledTimes(1);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(ctx.dir, "wiki/concepts/beta.md"), "utf8")).toBe(before);
    expect((await readState(ctx.dir)).sources["beta.md"]).toEqual(owner);
    const shared = await readFile(path.join(ctx.dir, "wiki/concepts/shared.md"), "utf8");
    for (const source of ["alpha.md", "beta.md", "gamma.md"]) expect(shared).toContain(source);
    const prompts = provider.complete.mock.calls.map(([system]) => system).join("\n");
    for (const name of ["Alpha", "Beta", "Gamma"]) expect(prompts).toContain(`${name} evidence`);
  });

  it("does not reuse a changed source", async () => {
    const provider = await seed();
    await writeFile(path.join(ctx.dir, "sources/alpha.md"), "# Alpha\n\nChanged Alpha evidence.");
    await compileAndReport(ctx.dir);
    expect(provider.toolCall).toHaveBeenCalledTimes(1);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(provider.toolCall.mock.calls[0][0]).toContain("Changed Alpha evidence");
  });

  it("updates a dropped assignment using its remaining cached owner", async () => {
    const provider = await seed();
    const beta = (await readState(ctx.dir)).sources["beta.md"];
    provider.toolCall.mockResolvedValue(JSON.stringify({ concepts: [
      { concept: "Alpha", summary: "Changed scope", is_new: false },
    ] }));
    await writeFile(path.join(ctx.dir, "sources/alpha.md"), "# Alpha\n\nAlpha now covers only its private subject.");
    await compileAndReport(ctx.dir);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const shared = parseFrontmatter(await readFile(path.join(ctx.dir, "wiki/concepts/shared.md"), "utf8"));
    expect(shared.meta.sources).toEqual(["beta.md"]);
    const state = await readState(ctx.dir);
    expect(state.sources["alpha.md"].concepts).toEqual(["alpha"]);
    expect(state.sources["beta.md"]).toEqual(beta);
  });

  it("keeps cached ownership and old pages when replacement validation fails", async () => {
    const provider = await seed();
    const before = await readState(ctx.dir);
    const page = await readFile(path.join(ctx.dir, "wiki/concepts/shared.md"), "utf8");
    provider.complete.mockResolvedValue("");
    expect((await addGamma()).errors.length).toBeGreaterThan(0);
    const after = await readState(ctx.dir);
    for (const file of ["alpha.md", "beta.md"]) expect(after.sources[file]).toEqual(before.sources[file]);
    expect(await readFile(path.join(ctx.dir, "wiki/concepts/shared.md"), "utf8")).toBe(page);
  });

  it("does not narrow existing ownership when affected pages are held by policy", async () => {
    const provider = await seed();
    const before = await readState(ctx.dir);
    await writeFile(path.join(ctx.dir, ".llmwiki/config.json"), JSON.stringify({
      version: 1, review: { hold: ["low-confidence"], lowConfidenceThreshold: 0.9 },
    }));
    const result = await addGamma();
    expect(result.review?.held).toHaveLength(2);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const after = await readState(ctx.dir);
    for (const file of ["alpha.md", "beta.md"]) expect(after.sources[file]).toEqual(before.sources[file]);
    expect(after.sources["gamma.md"].concepts).toEqual([]);
    expect(after.sources["gamma.md"].extraction).toBeUndefined();
  });

  it("falls back to extraction for legacy state without snapshots", async () => {
    const provider = await seed();
    const state = await readState(ctx.dir);
    for (const entry of Object.values(state.sources)) delete (entry as unknown as Record<string, unknown>).extraction;
    await writeState(ctx.dir, state);
    await addGamma();
    expect(provider.toolCall).toHaveBeenCalledTimes(3);
  });

  it("keeps deletion reconciliation on the fresh-extraction path", async () => {
    const provider = await seed();
    await rm(path.join(ctx.dir, "sources/alpha.md"));
    await compileAndReport(ctx.dir);
    expect(provider.toolCall).toHaveBeenCalledTimes(1);
    const shared = await readFile(path.join(ctx.dir, "wiki/concepts/shared.md"), "utf8");
    expect(shared).not.toContain("alpha.md");
  });

  it("does not reuse snapshots or advance state during reviewed staging", async () => {
    const provider = await seed();
    const before = await readFile(path.join(ctx.dir, ".llmwiki/state.json"), "utf8");
    await writeFile(path.join(ctx.dir, "sources/gamma.md"), "# Gamma\n\nGamma evidence.");
    await compileAndReport(ctx.dir, { review: true });
    expect(provider.toolCall).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(ctx.dir, ".llmwiki/state.json"), "utf8")).toBe(before);
  });

  it("re-extracts retry owners even when a valid snapshot exists", async () => {
    const provider = await seed();
    const state = await readState(ctx.dir);
    state.frozenSlugs = ["shared"];
    await writeState(ctx.dir, state);
    await compileAndReport(ctx.dir);
    expect(provider.toolCall).toHaveBeenCalledTimes(2);
    expect((await readState(ctx.dir)).frozenSlugs).toEqual([]);
  });
});
