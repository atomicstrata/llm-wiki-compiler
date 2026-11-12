import { describe, it, expect } from "bun:test";
import { slugify } from "../src/utils/markdown.js";

describe("slugify", () => {
  it("converts titles to lowercase hyphenated slugs", () => {
    expect(slugify("LLM Knowledge Bases")).toBe("llm-knowledge-bases");
  });

  it("strips apostrophes", () => {
    expect(slugify("Karpathy's Vision")).toBe("karpathys-vision");
  });

  it("strips smart quotes", () => {
    expect(slugify("Karpathy\u2019s Vision")).toBe("karpathys-vision");
  });

  it("strips punctuation", () => {
    expect(slugify("What is AI? (A Guide)")).toBe("what-is-ai-a-guide");
  });

  it("collapses multiple spaces into single hyphen", () => {
    expect(slugify("too   many    spaces")).toBe("too-many-spaces");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("already---hyphenated")).toBe("already-hyphenated");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("-leading and trailing-")).toBe("leading-and-trailing");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("handles single word", () => {
    expect(slugify("Concept")).toBe("concept");
  });

  // Issue #35: slugify must be Unicode-aware so non-ASCII titles don't
  // silently collapse to the empty string.
  it("preserves CJK characters", () => {
    expect(slugify("测试文档")).toBe("测试文档");
  });

  it("preserves Japanese hiragana and katakana", () => {
    expect(slugify("こんにちは カタカナ")).toBe("こんにちは-カタカナ");
  });

  it("preserves Cyrillic", () => {
    expect(slugify("Привет Мир")).toBe("привет-мир");
  });

  it("mixes Latin and CJK in the same slug", () => {
    expect(slugify("Hello 世界")).toBe("hello-世界");
  });

  it("strips emoji while keeping the surrounding letters", () => {
    expect(slugify("Hello 🌍 World")).toBe("hello-world");
  });

  it("returns empty string when the title has no letters or numbers", () => {
    expect(slugify("🎉🎊!!!")).toBe("");
  });
});
