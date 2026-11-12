import { describe, it, expect } from "bun:test";
import { validateWikiPage } from "../src/utils/markdown.js";

describe("validateWikiPage", () => {
  it("accepts a valid page with frontmatter and body", () => {
    const page = "---\ntitle: Test\nsummary: A test\n---\n\nSome body content.";
    expect(validateWikiPage(page)).toBe(true);
  });

  it("rejects empty content", () => {
    expect(validateWikiPage("")).toBe(false);
  });

  it("rejects whitespace-only content", () => {
    expect(validateWikiPage("   \n\n  ")).toBe(false);
  });

  it("rejects content without title in frontmatter", () => {
    const page = "---\nsummary: No title here\n---\n\nBody.";
    expect(validateWikiPage(page)).toBe(false);
  });

  it("rejects content with frontmatter but empty body", () => {
    const page = "---\ntitle: Test\n---\n";
    expect(validateWikiPage(page)).toBe(false);
  });

  it("rejects content with no frontmatter at all", () => {
    const page = "Just a plain body with no frontmatter.";
    expect(validateWikiPage(page)).toBe(false);
  });
});
