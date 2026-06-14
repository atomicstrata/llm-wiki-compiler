/**
 * Tests for the llmwiki export command and its format writers.
 *
 * Covers: artifact generation, basic schema validity, wikilink edge extraction,
 * and the --target filter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { runExport } from "../src/commands/export.js";
import type { ExportOptions, ExportResult } from "../src/commands/export.js";
import { extractWikilinkSlugs } from "../src/export/collect.js";
import { buildLlmsTxt, buildLlmsFullTxt } from "../src/export/llms-txt.js";
import { buildJsonExport } from "../src/export/json-export.js";
import { buildJsonLd } from "../src/export/json-ld.js";
import { buildGraphml } from "../src/export/graphml.js";
import { buildMarp } from "../src/export/marp.js";
import type { ExportPage } from "../src/export/types.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const SAMPLE_PAGE: ExportPage = {
  title: "Quantum Entanglement",
  slug: "quantum-entanglement",
  pageDirectory: "concepts",
  summary: "A spooky phenomenon.",
  sources: ["paper.md"],
  tags: ["physics"],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
  links: ["superposition"],
  body: "Entanglement connects particles across distances.",
};

const SECOND_PAGE: ExportPage = {
  title: "Superposition",
  slug: "superposition",
  pageDirectory: "concepts",
  summary: "States coexist.",
  sources: [],
  tags: ["physics", "quantum"],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  links: [],
  body: "A particle can be in multiple states.",
};

// ---------------------------------------------------------------------------
// extractWikilinkSlugs
// ---------------------------------------------------------------------------

describe("extractWikilinkSlugs", () => {
  it("extracts slugs from [[wikilinks]]", () => {
    const slugs = extractWikilinkSlugs("See [[Quantum Entanglement]] and [[Superposition]].");
    expect(slugs).toContain("quantum-entanglement");
    expect(slugs).toContain("superposition");
  });

  it("handles alias syntax [[Page|alias]]", () => {
    const slugs = extractWikilinkSlugs("See [[Quantum Entanglement|QE]].");
    expect(slugs).toContain("quantum-entanglement");
  });

  it("returns empty array when no wikilinks present", () => {
    expect(extractWikilinkSlugs("No links here.")).toEqual([]);
  });

  it("deduplicates repeated links", () => {
    const slugs = extractWikilinkSlugs("[[Alpha]] and [[Alpha]].");
    expect(slugs.filter((s) => s === "alpha").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// llms-txt format
// ---------------------------------------------------------------------------

describe("buildLlmsTxt", () => {
  it("includes H1 project title", () => {
    const out = buildLlmsTxt([SAMPLE_PAGE], "My Wiki");
    expect(out).toMatch(/^# My Wiki/);
  });

  it("lists each page as a markdown link with summary", () => {
    const out = buildLlmsTxt([SAMPLE_PAGE], "Wiki");
    expect(out).toContain("[Quantum Entanglement]");
    expect(out).toContain("A spooky phenomenon.");
  });

  it("includes page count in description line", () => {
    const out = buildLlmsTxt([SAMPLE_PAGE], "Wiki");
    expect(out).toContain("1 pages");
  });
});

describe("buildLlmsFullTxt", () => {
  it("includes all content from llms-txt header", () => {
    const out = buildLlmsFullTxt([SAMPLE_PAGE], "Wiki");
    expect(out).toMatch(/^# Wiki/);
  });

  it("appends full page body after the index", () => {
    const out = buildLlmsFullTxt([SAMPLE_PAGE], "Wiki");
    expect(out).toContain("Entanglement connects particles");
  });

  it("includes page title as section heading", () => {
    const out = buildLlmsFullTxt([SAMPLE_PAGE], "Wiki");
    expect(out).toContain("## Quantum Entanglement");
  });
});

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

describe("buildJsonExport", () => {
  it("produces valid JSON", () => {
    const out = buildJsonExport([SAMPLE_PAGE]);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("includes exportedAt and pageCount fields", () => {
    const doc = JSON.parse(buildJsonExport([SAMPLE_PAGE]));
    expect(doc).toHaveProperty("exportedAt");
    expect(doc.pageCount).toBe(1);
  });

  it("preserves page metadata", () => {
    const doc = JSON.parse(buildJsonExport([SAMPLE_PAGE]));
    const page = doc.pages[0];
    expect(page.title).toBe("Quantum Entanglement");
    expect(page.tags).toContain("physics");
    expect(page.sources).toContain("paper.md");
  });
});

// ---------------------------------------------------------------------------
// JSON-LD export
// ---------------------------------------------------------------------------

describe("buildJsonLd", () => {
  it("produces valid JSON", () => {
    const out = buildJsonLd([SAMPLE_PAGE]);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("uses schema.org context", () => {
    const doc = JSON.parse(buildJsonLd([SAMPLE_PAGE]));
    expect(doc["@context"]).toBe("https://schema.org");
  });

  it("includes graph nodes for each page", () => {
    const doc = JSON.parse(buildJsonLd([SAMPLE_PAGE, SECOND_PAGE]));
    expect(doc["@graph"].length).toBe(2);
  });

  it("represents wikilinks as mentions relationships", () => {
    const doc = JSON.parse(buildJsonLd([SAMPLE_PAGE]));
    const node = doc["@graph"][0];
    expect(node.mentions).toBeDefined();
    expect(node.mentions[0]["@id"]).toContain("superposition");
  });
});

// ---------------------------------------------------------------------------
// GraphML export
// ---------------------------------------------------------------------------

describe("buildGraphml", () => {
  it("produces well-formed XML with graphml root", () => {
    const out = buildGraphml([SAMPLE_PAGE, SECOND_PAGE]);
    expect(out).toContain('<?xml version="1.0"');
    expect(out).toContain("<graphml");
    expect(out).toContain("</graphml>");
  });

  it("includes a node for each page", () => {
    const out = buildGraphml([SAMPLE_PAGE, SECOND_PAGE]);
    expect(out).toContain('id="quantum-entanglement"');
    expect(out).toContain('id="superposition"');
  });

  it("includes edges for wikilinks between known pages", () => {
    const out = buildGraphml([SAMPLE_PAGE, SECOND_PAGE]);
    expect(out).toContain('source="quantum-entanglement" target="superposition"');
  });

  it("omits edges to unknown pages", () => {
    const isolated = { ...SAMPLE_PAGE, links: ["nonexistent-page"] };
    const out = buildGraphml([isolated]);
    expect(out).not.toContain("nonexistent-page");
  });

  it("escapes XML special chars in attributes", () => {
    const page = { ...SAMPLE_PAGE, title: "A & B < C", slug: "a-b-c" };
    const out = buildGraphml([page]);
    expect(out).toContain("A &amp; B &lt; C");
  });
});

// ---------------------------------------------------------------------------
// Marp export
// ---------------------------------------------------------------------------

describe("buildMarp", () => {
  it("starts with marp frontmatter", () => {
    const out = buildMarp([SAMPLE_PAGE], "My Wiki");
    expect(out).toContain("marp: true");
  });

  it("includes a title slide with the project title", () => {
    const out = buildMarp([SAMPLE_PAGE], "My Wiki");
    expect(out).toContain("# My Wiki");
  });

  it("produces one slide per page", () => {
    const out = buildMarp([SAMPLE_PAGE, SECOND_PAGE], "Wiki");
    const slideCount = (out.match(/^---$/gm) ?? []).length;
    // Frontmatter open+close + 1 per page slide separator = at least 3 ---
    expect(slideCount).toBeGreaterThanOrEqual(3);
  });

  it("includes page title and summary on each slide", () => {
    const out = buildMarp([SAMPLE_PAGE], "Wiki");
    expect(out).toContain("## Quantum Entanglement");
    expect(out).toContain("A spooky phenomenon.");
  });
});

// ---------------------------------------------------------------------------
// runExport integration
// ---------------------------------------------------------------------------

describe("runExport", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("export");
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      {
        title: "Alpha",
        summary: "First concept",
        sources: ["source.md"],
        tags: ["test"],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
      "Body of Alpha. Links to [[Beta]].",
    );
    await writePage(
      path.join(root, "wiki/concepts"),
      "beta",
      {
        title: "Beta",
        summary: "Second concept",
        sources: [],
        tags: [],
        createdAt: "2024-01-02T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
      "Body of Beta.",
    );
  });

  it("writes all six artifacts by default", async () => {
    const result: ExportResult = await runExport(root);
    expect(result.written.length).toBe(6);
    expect(result.pageCount).toBe(2);
  });

  it("writes files that exist on disk", async () => {
    const { written } = await runExport(root);
    for (const filePath of written) {
      const content = await readFile(filePath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("limits output to a single target when --target is specified", async () => {
    const opts: ExportOptions = { target: "json" };
    const result = await runExport(root, opts);
    expect(result.written.length).toBe(1);
    expect(result.written[0]).toContain("wiki.json");
  });

  it("throws for an unrecognised target", async () => {
    await expect(runExport(root, { target: "unknown-format" })).rejects.toThrow(
      /Unknown export target/,
    );
  });

  it("json artifact contains both pages", async () => {
    await runExport(root, { target: "json" });
    const content = await readFile(path.join(root, "dist/exports/wiki.json"), "utf-8");
    const doc = JSON.parse(content);
    expect(doc.pageCount).toBe(2);
  });

  it("graphml artifact contains an edge from alpha to beta", async () => {
    await runExport(root, { target: "graphml" });
    const content = await readFile(path.join(root, "dist/exports/wiki.graphml"), "utf-8");
    expect(content).toContain('source="alpha" target="beta"');
  });
});
