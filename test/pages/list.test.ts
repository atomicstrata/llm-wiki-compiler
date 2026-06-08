/**
 * Tests for getPage / listPages in src/pages/list.ts.
 *
 * Covers: path-safety rejection, sorted listing, body omitted by default,
 * links derived from the page body (not frontmatter), and getPage with body.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPage, listPages } from "../../src/pages/list.js";
import { PathSafetyError } from "../../src/viewer/path-safety.js";

async function writeConcept(root: string, slug: string, content: string) {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(root, `wiki/concepts/${slug}.md`), content, "utf-8");
}

async function seed(root: string) {
  await writeConcept(root, "b", "---\ntitle: B\nsummary: sb\ntags: [x]\n---\nbody-b [[a]]");
  await writeConcept(root, "a", "---\ntitle: A\nsummary: sa\n---\nbody-a");
}

describe("getPage / listPages", () => {
  it("rejects unsafe slugs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list-"));
    await expect(
      getPage(root, { pageDirectory: "concepts", slug: "../secret" }),
    ).rejects.toBeInstanceOf(PathSafetyError);
  });

  it("lists pages sorted by {pageDirectory, slug}, bodies omitted by default, links from body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list2-"));
    await seed(root);
    const { pages } = await listPages(root);
    expect(pages.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(pages[0].body).toBeUndefined();
    expect(pages.find((p) => p.slug === "b")?.links).toContain("a"); // [[a]] in body-b
    const withBody = await getPage(root, { pageDirectory: "concepts", slug: "a" });
    expect(withBody?.body).toContain("body-a");
  });

  it("getPage returns null for a missing slug", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list3-"));
    const page = await getPage(root, { pageDirectory: "concepts", slug: "nope" });
    expect(page).toBeNull();
  });

  it("excludes archived pages by default, includes them with includeArchived", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list4-"));
    await writeConcept(root, "live", "---\ntitle: Live\n---\nbody");
    await writeConcept(root, "old", "---\ntitle: Old\narchived: true\n---\nbody");
    const def = await listPages(root);
    expect(def.pages.map((p) => p.slug)).toEqual(["live"]);
    const all = await listPages(root, { includeArchived: true });
    expect(all.pages.map((p) => p.slug)).toEqual(["live", "old"]);
  });

  it("excludes orphaned pages by default, includes them with includeOrphaned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list5-"));
    await writeConcept(root, "live", "---\ntitle: Live\n---\nbody");
    await writeConcept(root, "ghost", "---\ntitle: Ghost\norphaned: true\n---\nbody");
    const def = await listPages(root);
    expect(def.pages.map((p) => p.slug)).toEqual(["live"]);
    const all = await listPages(root, { includeOrphaned: true });
    expect(all.pages.map((p) => p.slug)).toEqual(["ghost", "live"]);
  });

  it("paginates with limit and cursor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list6-"));
    await writeConcept(root, "a", "---\ntitle: A\n---\nbody");
    await writeConcept(root, "b", "---\ntitle: B\n---\nbody");
    await writeConcept(root, "c", "---\ntitle: C\n---\nbody");
    const first = await listPages(root, { limit: 2 });
    expect(first.pages.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(first.cursor).toBeDefined();
    const second = await listPages(root, { limit: 2, cursor: first.cursor });
    expect(second.pages.map((p) => p.slug)).toEqual(["c"]);
    expect(second.cursor).toBeUndefined();
  });

  it("includeBody populates body; default omits it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list7-"));
    await seed(root);
    const def = await listPages(root);
    expect(def.pages[0].body).toBeUndefined();
    const withBody = await listPages(root, { includeBody: true });
    expect(withBody.pages.find((p) => p.slug === "a")?.body).toContain("body-a");
  });

  it("throws on an invalid cursor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-list8-"));
    await seed(root);
    await expect(listPages(root, { cursor: "abc" })).rejects.toThrow(/invalid listPages cursor/);
    await expect(listPages(root, { cursor: "-2" })).rejects.toThrow(/invalid listPages cursor/);
  });
});
