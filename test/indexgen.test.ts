import { describe, it, expect, beforeEach } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { buildFrontmatter } from "../src/utils/markdown.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { generateAndReadIndex } from "./fixtures/generate-and-read-index.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";

describe("generateIndex", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("idx");
  });

  it("includes concept pages in the index", async () => {
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "First concept" }, "Body of Alpha.");
    const index = await generateAndReadIndex(root);

    expect(index).toContain("[[alpha|Alpha]]");
    expect(index).toContain("First concept");
    expect(index).toContain("## Concepts");
  });

  it("includes saved query pages in a separate section", async () => {
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "A concept" }, "Body of Alpha.");
    await writePage(path.join(root, "wiki/queries"), "what-is-alpha", { title: "What is Alpha?", summary: "A query answer" }, "Body of What is Alpha?.");
    const index = await generateAndReadIndex(root);

    expect(index).toContain("## Concepts");
    expect(index).toContain("[[alpha|Alpha]]");
    expect(index).toContain("## Saved Queries");
    expect(index).toContain("[[what-is-alpha|What is Alpha?]]");
  });

  it("omits Saved Queries section when no queries exist", async () => {
    await writePage(path.join(root, "wiki/concepts"), "beta", { title: "Beta", summary: "A concept" }, "Body of Beta.");
    const index = await generateAndReadIndex(root);

    expect(index).toContain("## Concepts");
    expect(index).not.toContain("## Saved Queries");
  });

  it("reports correct total page count", async () => {
    await writePage(path.join(root, "wiki/concepts"), "a", { title: "A", summary: "s" }, "Body.");
    await writePage(path.join(root, "wiki/concepts"), "b", { title: "B", summary: "s" }, "Body.");
    await writePage(path.join(root, "wiki/queries"), "q", { title: "Q", summary: "s" }, "Body.");
    const index = await generateAndReadIndex(root);

    expect(index).toContain("3 pages");
  });

  it("handles empty wiki gracefully", async () => {
    const index = await generateAndReadIndex(root);

    expect(index).toContain("0 pages");
  });

  it("excludes orphaned pages from the index", async () => {
    await writePage(path.join(root, "wiki/concepts"), "alive", { title: "Alive", summary: "Still here" }, "Body of Alive.");
    const orphanFm = buildFrontmatter({ title: "Dead", summary: "Gone", orphaned: true });
    await writeFile(
      path.join(root, "wiki/concepts/dead.md"),
      `${orphanFm}\n\nOrphaned content.\n`,
    );
    const index = await generateAndReadIndex(root);

    expect(index).toContain("[[alive|Alive]]");
    expect(index).not.toContain("[[dead|Dead]]");
    expect(index).toContain("1 pages");
  });

  it("omits typed entity sections for a DEFAULT project (byte-identical)", async () => {
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "A concept" }, "Body of Alpha.");
    const index = await generateAndReadIndex(root);

    // A default project (no profile.json) renders exactly the legacy sections.
    expect(index).toContain("# Knowledge Wiki");
    expect(index).toContain("## Concepts");
    expect(index).not.toContain("## Papers");
    expect(index).not.toContain("## Entity Pages");
  });
});

describe("generateIndex (non-default profile)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("idx-profile");
    await buildResearchLiteProject(root);
  });

  it("lists a promoted typed page under its entity-type section", async () => {
    const index = await generateAndReadIndex(root);

    expect(index).toContain("## Papers");
    expect(index).toContain("attention-is-all-you-need");
    expect(index).toContain("papers/attention-is-all-you-need.md");
  });

  it("groups pages under one section per entity type", async () => {
    const index = await generateAndReadIndex(root);

    expect(index).toContain("## Papers");
    expect(index).toContain("## Ideas");
    expect(index).toContain("## Experiments");
    expect(index).toContain("ideas/sparse-routing.md");
    expect(index).toContain("experiments/ablation-batch-size.md");
  });

  it("still renders the default Concepts section alongside typed sections", async () => {
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "A concept" }, "Body of Alpha.");
    const index = await generateAndReadIndex(root);

    expect(index).toContain("## Concepts");
    expect(index).toContain("[[alpha|Alpha]]");
    expect(index).toContain("## Papers");
  });
});
