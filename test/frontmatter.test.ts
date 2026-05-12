import { describe, it, expect } from "vitest";
import {
  buildFrontmatter,
  parseFrontmatter,
  parseFrontmatterStatus,
  extractCitations,
} from "../src/utils/markdown.js";

describe("buildFrontmatter", () => {
  it("wraps fields in YAML delimiters", () => {
    const result = buildFrontmatter({ title: "Test" });
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---$/);
  });

  it("includes string fields", () => {
    const result = buildFrontmatter({ title: "My Title", summary: "A summary" });
    expect(result).toContain("title:");
    expect(result).toContain("summary:");
  });

  it("includes array fields", () => {
    const result = buildFrontmatter({ sources: ["a.md", "b.md"] });
    expect(result).toContain("a.md");
    expect(result).toContain("b.md");
  });

  it("includes boolean fields", () => {
    const result = buildFrontmatter({ orphaned: true });
    expect(result).toContain("orphaned: true");
  });
});

describe("parseFrontmatter", () => {
  it("extracts meta and body", () => {
    const content = "---\ntitle: Test\n---\nBody text here.";
    const { meta, body } = parseFrontmatter(content);
    expect(meta.title).toBe("Test");
    expect(body).toBe("Body text here.");
  });

  it("returns empty meta for content without frontmatter", () => {
    const { meta, body } = parseFrontmatter("Just some text.");
    expect(meta).toEqual({});
    expect(body).toBe("Just some text.");
  });

  it("returns empty meta for malformed YAML without crashing", () => {
    const content = "---\n: invalid: yaml: [broken\n---\nBody here.";
    const { meta, body } = parseFrontmatter(content);
    expect(meta).toEqual({});
    expect(body).toBe("Body here.");
  });

  it("preserves body content exactly", () => {
    const bodyText = "\n## Section\n\nParagraph with **bold**.\n";
    const content = `---\ntitle: Test\n---\n${bodyText}`;
    const { body } = parseFrontmatter(content);
    expect(body).toBe(bodyText);
  });

  it("parses boolean values as booleans", () => {
    const content = "---\norphaned: true\n---\nBody.";
    const { meta } = parseFrontmatter(content);
    expect(meta.orphaned).toBe(true);
  });

  it("parses array values as arrays", () => {
    const content = "---\nsources:\n  - a.md\n  - b.md\n---\nBody.";
    const { meta } = parseFrontmatter(content);
    expect(meta.sources).toEqual(["a.md", "b.md"]);
  });
});

describe("extractCitations", () => {
  it("parses single citations", () => {
    const body = "Some paragraph text. ^[source.md]";
    expect(extractCitations(body)).toEqual(["source.md"]);
  });

  it("parses multi-source citations", () => {
    const body = "Some paragraph text. ^[a.md, b.md]";
    const result = extractCitations(body);
    expect(result).toContain("a.md");
    expect(result).toContain("b.md");
    expect(result).toHaveLength(2);
  });

  it("returns unique filenames", () => {
    const body = "First paragraph. ^[source.md]\n\nSecond paragraph. ^[source.md]";
    expect(extractCitations(body)).toEqual(["source.md"]);
  });

  it("returns empty array for no citations", () => {
    const body = "A paragraph with no citations at all.";
    expect(extractCitations(body)).toEqual([]);
  });

  it("collects citations from multiple paragraphs", () => {
    const body = "Para one. ^[a.md]\n\nPara two. ^[b.md, c.md]";
    const result = extractCitations(body);
    expect(result).toContain("a.md");
    expect(result).toContain("b.md");
    expect(result).toContain("c.md");
    expect(result).toHaveLength(3);
  });
});

describe("parseFrontmatterStatus", () => {
  it("flags well-formed frontmatter", () => {
    const status = parseFrontmatterStatus("---\ntitle: Test\n---\nBody.");
    expect(status.hasFrontmatterBlock).toBe(true);
    expect(status.malformedFrontmatter).toBe(false);
    expect(status.meta.title).toBe("Test");
    expect(status.body).toBe("Body.");
  });

  it("flags content without a frontmatter block", () => {
    const status = parseFrontmatterStatus("Just some text.");
    expect(status.hasFrontmatterBlock).toBe(false);
    expect(status.malformedFrontmatter).toBe(false);
    expect(status.meta).toEqual({});
    expect(status.body).toBe("Just some text.");
  });

  it("flags malformed YAML inside a frontmatter block", () => {
    const status = parseFrontmatterStatus("---\n: invalid: yaml: [broken\n---\nBody.");
    expect(status.hasFrontmatterBlock).toBe(true);
    expect(status.malformedFrontmatter).toBe(true);
    expect(status.meta).toEqual({});
    expect(status.body).toBe("Body.");
  });

  it("flags YAML that parses to a non-object as malformed", () => {
    const status = parseFrontmatterStatus("---\njust-a-scalar\n---\nBody.");
    expect(status.hasFrontmatterBlock).toBe(true);
    expect(status.malformedFrontmatter).toBe(true);
  });
});

describe("frontmatter round-trip", () => {
  it("preserves values through build then parse", () => {
    const fields = {
      title: "Test Concept",
      summary: "A test summary",
      sources: ["source-a.md", "source-b.md"],
      createdAt: "2026-04-04T00:00:00.000Z",
      updatedAt: "2026-04-04T00:00:00.000Z",
    };

    const built = buildFrontmatter(fields);
    const { meta } = parseFrontmatter(built + "\n\nBody.");

    expect(meta.title).toBe(fields.title);
    expect(meta.summary).toBe(fields.summary);
    expect(meta.sources).toEqual(fields.sources);
    expect(meta.createdAt).toBe(fields.createdAt);
    expect(meta.updatedAt).toBe(fields.updatedAt);
  });

  it("preserves boolean values through round-trip", () => {
    const fields = { title: "Orphan", orphaned: true };
    const built = buildFrontmatter(fields);
    const { meta } = parseFrontmatter(built + "\n\nBody.");
    expect(meta.orphaned).toBe(true);
  });
});
