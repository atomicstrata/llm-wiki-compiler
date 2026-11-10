import { describe, it, expect, beforeEach } from "bun:test";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { addObsidianMeta, generateMOC } from "../src/compiler/obsidian.js";
import { buildFrontmatter } from "../src/utils/markdown.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

/** Write a concept page with optional tags. */
async function writePage(
  dir: string,
  slug: string,
  title: string,
  tags?: string[],
): Promise<void> {
  const fields: Record<string, unknown> = { title, summary: "A summary" };
  if (tags) fields.tags = tags;
  const fm = buildFrontmatter(fields);
  await writeFile(path.join(dir, `${slug}.md`), `${fm}\n\nBody of ${title}.\n`);
}

describe("addObsidianMeta", () => {
  it("sets tags from input", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "Test", ["ml", "optimization"]);
    expect(fm.tags).toEqual(["ml", "optimization"]);
  });

  it("sets empty tags from empty input", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "Test", []);
    expect(fm.tags).toEqual([]);
  });

  it("generates slug alias", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "Gradient Descent", []);
    expect(fm.aliases).toContain("gradient-descent");
  });

  it("generates word-swap alias for titles with 'and'", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "Gradient Descent and Optimization", []);
    expect(fm.aliases).toContain("Optimization and Gradient Descent");
  });

  it("generates word-swap alias for titles with 'or'", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "Precision or Recall", []);
    expect(fm.aliases).toContain("Recall or Precision");
  });

  it("generates abbreviation for 3+ word titles", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "Retrieval Augmented Generation", []);
    expect(fm.aliases).toContain("RAG");
  });

  it("returns empty aliases when title is one word", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "embeddings", []);
    expect(fm.aliases).toEqual([]);
  });

  it("does not include slug alias when slug equals title", () => {
    const fm: Record<string, unknown> = {};
    addObsidianMeta(fm, "test", []);
    expect(fm.aliases).toEqual([]);
  });
});

describe("generateMOC", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("obs");
  });

  it("groups pages by tag", async () => {
    const dir = path.join(root, "wiki/concepts");
    await writePage(dir, "alpha", "Alpha", ["ml"]);
    await writePage(dir, "beta", "Beta", ["ml"]);
    await writePage(dir, "gamma", "Gamma", ["databases"]);

    await generateMOC(root);
    const moc = await readFile(path.join(root, "wiki/MOC.md"), "utf-8");

    expect(moc).toContain("## ml");
    expect(moc).toContain("## databases");
    expect(moc).toContain("[[alpha|Alpha]]");
    expect(moc).toContain("[[beta|Beta]]");
    expect(moc).toContain("[[gamma|Gamma]]");
  });

  it("includes uncategorized section for tagless pages", async () => {
    const dir = path.join(root, "wiki/concepts");
    await writePage(dir, "alpha", "Alpha", ["ml"]);
    await writePage(dir, "beta", "Beta");

    await generateMOC(root);
    const moc = await readFile(path.join(root, "wiki/MOC.md"), "utf-8");

    expect(moc).toContain("## Uncategorized");
    expect(moc).toContain("[[beta|Beta]]");
  });

  it("creates valid markdown output", async () => {
    const dir = path.join(root, "wiki/concepts");
    await writePage(dir, "alpha", "Alpha", ["ml"]);

    await generateMOC(root);
    const moc = await readFile(path.join(root, "wiki/MOC.md"), "utf-8");

    expect(moc).toMatch(/^# Map of Content/);
    expect(moc).toContain("- [[alpha|Alpha]]");
  });

  it("handles empty concepts directory", async () => {
    await generateMOC(root);
    const moc = await readFile(path.join(root, "wiki/MOC.md"), "utf-8");
    expect(moc).toContain("# Map of Content");
  });

  it("excludes orphaned pages", async () => {
    const dir = path.join(root, "wiki/concepts");
    await writePage(dir, "alive", "Alive", ["ml"]);
    const orphanFm = buildFrontmatter({ title: "Dead", summary: "Gone", orphaned: true, tags: ["ml"] });
    await writeFile(path.join(dir, "dead.md"), `${orphanFm}\n\nOrphaned.\n`);

    await generateMOC(root);
    const moc = await readFile(path.join(root, "wiki/MOC.md"), "utf-8");

    expect(moc).toContain("[[alive|Alive]]");
    expect(moc).not.toContain("[[dead|Dead]]");
  });
});
