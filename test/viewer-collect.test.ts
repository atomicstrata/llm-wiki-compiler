/**
 * Tests for the viewer-facing page collector.
 *
 * Verifies the spec's Slice 1 acceptance criteria: Unicode slug round-trip,
 * malformed-but-readable retention with stable warning codes, duplicate
 * slug handling across concepts/queries, the bare-slug precedence rule,
 * and that `wiki/index.md` is intentionally excluded from the page list.
 */

import { describe, it, expect } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { collectViewerPages, resolveBareSlug } from "../src/viewer/collect.js";

describe("collectViewerPages — IDs and metadata", () => {
  it("assigns namespaced IDs for concept and query pages", async () => {
    const root = await makeTempRoot("viewer-collect-ids");
    await writePage(path.join(root, "wiki/concepts"), "attention", { title: "Attention" }, "B.");
    await writePage(path.join(root, "wiki/queries"), "q", { title: "Q" }, "B.");
    const pages = await collectViewerPages(root);
    const ids = pages.map((p) => p.id).sort();
    expect(ids).toEqual(["concepts/attention", "queries/q"]);
  });

  it("supports Unicode slugs end-to-end", async () => {
    const root = await makeTempRoot("viewer-collect-unicode");
    await writePage(path.join(root, "wiki/concepts"), "注意力", { title: "注意力" }, "B.");
    const pages = await collectViewerPages(root);
    expect(pages[0].slug).toBe("注意力");
    expect(pages[0].id).toBe("concepts/注意力");
  });

  it("does not include wiki/index.md in the page list", async () => {
    const root = await makeTempRoot("viewer-collect-no-index");
    await writePage(path.join(root, "wiki/concepts"), "a", { title: "A" }, "B.");
    await writeFile(path.join(root, "wiki", "index.md"), "# Index\n[[a]]");
    const pages = await collectViewerPages(root);
    expect(pages.map((p) => p.slug)).toEqual(["a"]);
  });

  it("retains a duplicate slug across concepts and queries with distinct IDs", async () => {
    const root = await makeTempRoot("viewer-collect-dup");
    await writePage(path.join(root, "wiki/concepts"), "shared", { title: "Shared C" }, "B.");
    await writePage(path.join(root, "wiki/queries"), "shared", { title: "Shared Q" }, "B.");
    const pages = await collectViewerPages(root);
    expect(pages.map((p) => p.id).sort()).toEqual([
      "concepts/shared",
      "queries/shared",
    ]);
  });
});

describe("collectViewerPages — warnings and fallback titles", () => {
  it("emits malformed_frontmatter for broken YAML and retains the page", async () => {
    const root = await makeTempRoot("viewer-collect-bad-yaml");
    await writeFile(
      path.join(root, "wiki/concepts/bad.md"),
      "---\n: invalid: yaml: [broken\n---\nBody.\n",
    );
    const pages = await collectViewerPages(root);
    expect(pages).toHaveLength(1);
    const codes = pages[0].warnings.map((w) => w.code);
    expect(codes).toContain("malformed_frontmatter");
  });

  it("emits missing_frontmatter when no block is present", async () => {
    const root = await makeTempRoot("viewer-collect-no-fm");
    await writeFile(path.join(root, "wiki/concepts/no-fm.md"), "Just body.\n");
    const pages = await collectViewerPages(root);
    const codes = pages[0].warnings.map((w) => w.code);
    expect(codes).toContain("missing_frontmatter");
  });

  it("emits missing_title and falls back to the slug when title is absent", async () => {
    const root = await makeTempRoot("viewer-collect-no-title");
    await writePage(path.join(root, "wiki/concepts"), "no-title", { summary: "x" }, "B.");
    const pages = await collectViewerPages(root);
    expect(pages[0].title).toBe("no-title");
    expect(pages[0].warnings.map((w) => w.code)).toContain("missing_title");
  });
});

describe("collectViewerPages — outgoing links and bare-slug resolution", () => {
  it("resolves a bare-slug wikilink to the concepts page when both exist", async () => {
    const root = await makeTempRoot("viewer-collect-precedence");
    await writePage(path.join(root, "wiki/concepts"), "shared", { title: "Shared C" }, "B.");
    await writePage(path.join(root, "wiki/queries"), "shared", { title: "Shared Q" }, "B.");
    await writePage(
      path.join(root, "wiki/concepts"),
      "linker",
      { title: "Linker" },
      "See [[shared]] for more.",
    );
    const pages = await collectViewerPages(root);
    const linker = pages.find((p) => p.slug === "linker");
    expect(linker?.outgoingLinks).toEqual(["concepts/shared"]);
  });

  it("drops unresolved bare-slug wikilinks from outgoingLinks", async () => {
    const root = await makeTempRoot("viewer-collect-unresolved");
    await writePage(
      path.join(root, "wiki/concepts"),
      "linker",
      { title: "Linker" },
      "See [[ghost]] for more.",
    );
    const pages = await collectViewerPages(root);
    expect(pages[0].outgoingLinks).toEqual([]);
  });

  it("resolveBareSlug returns null for an empty or unknown slug", async () => {
    const root = await makeTempRoot("viewer-collect-null");
    await writePage(path.join(root, "wiki/concepts"), "a", { title: "A" }, "B.");
    const pages = await collectViewerPages(root);
    expect(resolveBareSlug("", pages)).toBeNull();
    expect(resolveBareSlug("ghost", pages)).toBeNull();
    expect(resolveBareSlug("a", pages)).toBe("concepts/a");
  });
});
