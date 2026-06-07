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

async function seed(root: string) {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(
    path.join(root, "wiki/concepts/b.md"),
    "---\ntitle: B\nsummary: sb\ntags: [x]\n---\nbody-b [[a]]",
    "utf-8",
  );
  await writeFile(
    path.join(root, "wiki/concepts/a.md"),
    "---\ntitle: A\nsummary: sa\n---\nbody-a",
    "utf-8",
  );
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
});
