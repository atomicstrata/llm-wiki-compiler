/**
 * Unit tests for the output-language resolver and its impact on the
 * prompt builders (issue #37).
 *
 * Default behaviour (no env, no flag) must produce prompts byte-identical
 * to the previous implementation. When `LLMWIKI_OUTPUT_LANG` is set, the
 * directive must appear in every system prompt the compile and seed
 * pipelines emit.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  getOutputLanguage,
  languageDirective,
} from "../src/utils/output-language.js";
import {
  buildExtractionPrompt,
  buildPagePrompt,
  buildSeedPagePrompt,
} from "../src/compiler/prompts.js";
import type { PageKindRule, SeedPage } from "../src/schema/index.js";

const ENV_KEY = "LLMWIKI_OUTPUT_LANG";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("getOutputLanguage", () => {
  it("returns null when env var is unset", () => {
    expect(getOutputLanguage()).toBeNull();
  });

  it("returns null when env var is empty or whitespace", () => {
    process.env[ENV_KEY] = "   ";
    expect(getOutputLanguage()).toBeNull();
  });

  it("returns the trimmed value when set", () => {
    process.env[ENV_KEY] = "  zh-CN  ";
    expect(getOutputLanguage()).toBe("zh-CN");
  });
});

describe("languageDirective", () => {
  it("returns an empty string when no language is configured", () => {
    expect(languageDirective()).toBe("");
  });

  it("returns 'Write the output in <lang>.' when configured", () => {
    process.env[ENV_KEY] = "Chinese";
    expect(languageDirective()).toBe("Write the output in Chinese.");
  });
});

describe("prompt builders honour LLMWIKI_OUTPUT_LANG (#37)", () => {
  it("buildExtractionPrompt omits the directive by default", () => {
    const out = buildExtractionPrompt("source", "");
    expect(out).not.toContain("Write the output in");
  });

  it("buildExtractionPrompt includes the directive when set", () => {
    process.env[ENV_KEY] = "Spanish";
    const out = buildExtractionPrompt("source", "");
    expect(out).toContain("Write the output in Spanish.");
  });

  it("buildPagePrompt omits the directive by default", () => {
    const out = buildPagePrompt("Concept", "src", "", "");
    expect(out).not.toContain("Write the output in");
  });

  it("buildPagePrompt includes the directive when set", () => {
    process.env[ENV_KEY] = "Japanese";
    const out = buildPagePrompt("Concept", "src", "", "");
    expect(out).toContain("Write the output in Japanese.");
  });

  it("buildSeedPagePrompt omits the directive by default", () => {
    const seed: SeedPage = {
      title: "Overview",
      kind: "overview",
      summary: "test",
      relatedSlugs: [],
    };
    const rule: PageKindRule = {
      description: "an overview page",
      minWikilinks: 0,
    };
    const out = buildSeedPagePrompt(seed, rule, "related");
    expect(out).not.toContain("Write the output in");
  });

  it("buildSeedPagePrompt includes the directive when set", () => {
    process.env[ENV_KEY] = "Cantonese";
    const seed: SeedPage = {
      title: "Overview",
      kind: "overview",
      summary: "test",
      relatedSlugs: [],
    };
    const rule: PageKindRule = {
      description: "an overview page",
      minWikilinks: 0,
    };
    const out = buildSeedPagePrompt(seed, rule, "related");
    expect(out).toContain("Write the output in Cantonese.");
  });
});
