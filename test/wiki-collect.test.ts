/**
 * Tests for the shared low-level wiki collector.
 *
 * These assertions lock in the layer boundary: `collectRawWikiPages`
 * returns structural `parseStatus` flags only, never the viewer-facing
 * `ViewerWarning` objects produced one layer up. The export collector
 * and the viewer collector both depend on this contract.
 */

import { describe, it, expect } from "vitest";
import { symlink, writeFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { collectRawWikiPages, extractWikilinkSlugs, extractWikilinkTargets } from "../src/wiki/collect.js";

describe("collectRawWikiPages", () => {
  it("collects pages from concepts and queries directories", async () => {
    const root = await makeTempRoot("wiki-collect");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "Body.");
    await writePage(path.join(root, "wiki/queries"), "qq", { title: "QQ" }, "Body.");
    const pages = await collectRawWikiPages(root);
    const dirs = pages.map((p) => p.pageDirectory).sort();
    expect(dirs).toEqual(["concepts", "queries"]);
  });

  it("preserves filename stems as slugs (no slugify)", async () => {
    const root = await makeTempRoot("wiki-collect-stem");
    await writePage(path.join(root, "wiki/concepts"), "Mixed_CASE-slug", { title: "T" }, "B.");
    const pages = await collectRawWikiPages(root);
    expect(pages[0].slug).toBe("Mixed_CASE-slug");
  });

  it("retains pages with missing frontmatter and flags parseStatus", async () => {
    const root = await makeTempRoot("wiki-collect-no-fm");
    await writeFile(path.join(root, "wiki/concepts/no-fm.md"), "Just body text.\n");
    const pages = await collectRawWikiPages(root);
    expect(pages).toHaveLength(1);
    expect(pages[0].parseStatus.hasFrontmatterBlock).toBe(false);
    expect(pages[0].parseStatus.hasTitle).toBe(false);
  });

  it("retains pages with malformed YAML and flags parseStatus", async () => {
    const root = await makeTempRoot("wiki-collect-bad-yaml");
    await writeFile(
      path.join(root, "wiki/concepts/bad.md"),
      "---\n: invalid: yaml: [broken\n---\nBody.\n",
    );
    const pages = await collectRawWikiPages(root);
    expect(pages).toHaveLength(1);
    expect(pages[0].parseStatus.hasFrontmatterBlock).toBe(true);
    expect(pages[0].parseStatus.malformedFrontmatter).toBe(true);
    expect(pages[0].parseStatus.hasTitle).toBe(false);
  });

  it("flags orphaned pages without dropping them", async () => {
    const root = await makeTempRoot("wiki-collect-orphan");
    await writePage(
      path.join(root, "wiki/concepts"),
      "orphan",
      { title: "Orphan", orphaned: true },
      "Body.",
    );
    const pages = await collectRawWikiPages(root);
    expect(pages).toHaveLength(1);
    expect(pages[0].parseStatus.orphaned).toBe(true);
  });

  it("does not emit ViewerWarning objects — only parseStatus", async () => {
    const root = await makeTempRoot("wiki-collect-no-warnings");
    await writeFile(path.join(root, "wiki/concepts/x.md"), "Body without frontmatter.\n");
    const pages = await collectRawWikiPages(root);
    expect("warnings" in pages[0]).toBe(false);
  });

  it("ignores non-.md files and missing directories", async () => {
    const root = await makeTempRoot("wiki-collect-mixed");
    await writeFile(path.join(root, "wiki/concepts/readme.txt"), "not markdown");
    const pages = await collectRawWikiPages(root);
    expect(pages).toHaveLength(0);
  });

  it("drops a symlinked concept file that resolves outside the project root", async () => {
    const root = await makeTempRoot("wiki-collect-symlink-file");
    const outside = await makeOutsideDir();
    const outsideFile = path.join(outside, "secret.md");
    await writeFile(outsideFile, "---\ntitle: Secret\n---\nLeaked.\n");
    await symlink(outsideFile, path.join(root, "wiki/concepts/escape.md"));
    await assertConceptSlugDropped(root, "escape");
  });

  it("drops a concept entry whose symlinked directory resolves outside the project root", async () => {
    const root = await makeTempRoot("wiki-collect-symlink-dir");
    const outside = await makeOutsideDir();
    await writeFile(outside + "/leaked.md", "---\ntitle: Leaked\n---\nBody.\n");
    // Replace wiki/concepts with a symlink pointing outside the project.
    const { rm } = await import("fs/promises");
    await rm(path.join(root, "wiki/concepts"), { recursive: true });
    await symlink(outside, path.join(root, "wiki/concepts"));

    const pages = await collectRawWikiPages(root);
    expect(pages.some((p) => p.slug === "leaked")).toBe(false);
  });

  it("drops a concept symlink whose target is in-root but outside wiki/concepts/", async () => {
    const root = await makeTempRoot("wiki-collect-symlink-inroot-file");
    // The escape target is a regular file inside the project root — the
    // weaker "under root" check would have accepted this.
    await writeFile(
      path.join(root, "README.md"),
      "---\ntitle: README\n---\nProject readme, not a wiki page.\n",
    );
    await symlink(path.join(root, "README.md"), path.join(root, "wiki/concepts/inroot.md"));
    await assertConceptSlugDropped(root, "inroot");
  });

  it("drops a concept symlink whose target lives under wiki/queries/", async () => {
    const root = await makeTempRoot("wiki-collect-symlink-cross-namespace");
    await writePage(path.join(root, "wiki/queries"), "q1", { title: "Query 1" }, "B.");
    await symlink(
      path.join(root, "wiki/queries/q1.md"),
      path.join(root, "wiki/concepts/cross.md"),
    );
    const pages = await collectRawWikiPages(root);
    // q1 must be present from wiki/queries; the symlinked cross-namespace
    // concept entry must be dropped (resolves outside wiki/concepts/).
    expect(pages.some((p) => p.pageDirectory === "queries" && p.slug === "q1")).toBe(true);
    expect(pages.some((p) => p.pageDirectory === "concepts" && p.slug === "cross")).toBe(false);
  });

  it("drops every entry when wiki/concepts itself is a symlink, even to an in-root directory", async () => {
    const root = await makeTempRoot("wiki-collect-dir-symlink-inroot");
    const real = path.join(root, "actual-concepts");
    const { rm, mkdir } = await import("fs/promises");
    await mkdir(real, { recursive: true });
    await writeFile(
      path.join(real, "x.md"),
      "---\ntitle: X\n---\nBody.\n",
    );
    await rm(path.join(root, "wiki/concepts"), { recursive: true });
    await symlink(real, path.join(root, "wiki/concepts"));

    const pages = await collectRawWikiPages(root);
    expect(pages.filter((p) => p.pageDirectory === "concepts")).toHaveLength(0);
  });
});

/**
 * Shared assertion for symlink-escape regression cases: drops a known-
 * legitimate `ok.md` concept alongside the symlinked entry, then runs
 * the collector and asserts `ok` survived while `droppedSlug` did not.
 * Keeps each test focused on its specific symlink setup.
 */
async function assertConceptSlugDropped(root: string, droppedSlug: string): Promise<void> {
  await writePage(path.join(root, "wiki/concepts"), "ok", { title: "OK" }, "B.");
  const pages = await collectRawWikiPages(root);
  const slugs = pages.map((p) => p.slug);
  expect(slugs).toContain("ok");
  expect(slugs).not.toContain(droppedSlug);
}

describe("extractWikilinkSlugs", () => {
  it("returns deduplicated slugified targets", () => {
    const body = "See [[Alpha]] and [[alpha]] and [[Beta Page]].";
    const targets = extractWikilinkSlugs(body);
    expect(targets).toContain("alpha");
    expect(targets).toContain("beta-page");
  });

  it("strips alias suffixes after the pipe", () => {
    const body = "Refer to [[Alpha|the alpha one]].";
    expect(extractWikilinkSlugs(body)).toEqual(["alpha"]);
  });

  it("returns an empty array when no wikilinks are present", () => {
    expect(extractWikilinkSlugs("No links here.")).toEqual([]);
  });
});

describe("extractWikilinkTargets", () => {
  it("uses alias as display text when pipe syntax is present", () => {
    const targets = extractWikilinkTargets("See [[missing-page|Custom Label]] here.");
    expect(targets).toEqual([{ slug: "missing-page", display: "Custom Label" }]);
  });

  it("falls back to target as display text when no alias is present", () => {
    const targets = extractWikilinkTargets("See [[some-page]] here.");
    expect(targets).toEqual([{ slug: "some-page", display: "some-page" }]);
  });
});
