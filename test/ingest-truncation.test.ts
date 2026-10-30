import { afterEach, describe, it, expect, vi } from "vitest";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { enforceCharLimit, buildDocument } from "../src/commands/ingest.js";
import { MAX_SOURCE_CHARS, resolveMaxSourceChars } from "../src/utils/constants.js";

/**
 * Tests that the ingest command preserves truncation metadata in frontmatter.
 * Validates the "honest tracking" principle: the system records when and how
 * much content was lost during ingestion.
 *
 * Calls the real enforceCharLimit and buildDocument functions to verify the
 * actual truncation pipeline, not a reimplementation.
 */

describe("ingest truncation metadata", () => {
  it("enforceCharLimit returns truncated: true and original length for oversized content", () => {
    const big = "x".repeat(150_000);
    const result = enforceCharLimit(big);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(150_000);
    expect(result.content.length).toBe(100_000);
  });

  it("enforceCharLimit returns truncated: false for content within the limit", () => {
    const small = "hello world";
    const result = enforceCharLimit(small);

    expect(result.truncated).toBe(false);
    expect(result.originalChars).toBe(small.length);
    expect(result.content).toBe(small);
  });

  it("buildDocument includes truncation metadata in frontmatter when truncated", () => {
    const result = enforceCharLimit("y".repeat(150_000));
    const doc = buildDocument("Test Article", "https://example.com/article", result);
    const { meta } = parseFrontmatter(doc);

    expect(meta.truncated).toBe(true);
    expect(meta.originalChars).toBe(150_000);
    expect(meta.title).toBe("Test Article");
    expect(meta.source).toBe("https://example.com/article");
  });

  it("buildDocument omits truncation fields when content was not truncated", () => {
    const result = enforceCharLimit("Short content here");
    const doc = buildDocument("Short Article", "https://example.com/short", result);
    const { meta } = parseFrontmatter(doc);

    expect(meta.truncated).toBeUndefined();
    expect(meta.originalChars).toBeUndefined();
    expect(meta.title).toBe("Short Article");
  });

  it("truncation metadata survives frontmatter round-trip with correct types", () => {
    const result = enforceCharLimit("z".repeat(200_000));
    const doc = buildDocument("Big Doc", "/path/to/file.txt", result);
    const { meta } = parseFrontmatter(doc);

    expect(typeof meta.truncated).toBe("boolean");
    expect(meta.truncated).toBe(true);
    expect(typeof meta.originalChars).toBe("number");
    expect(meta.originalChars).toBe(200_000);
  });

  it("takes an explicit limit for callers that resolved one", () => {
    const result = enforceCharLimit("w".repeat(250), 200);

    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(200);
    expect(result.originalChars).toBe(250);
  });
});

describe("LLMWIKI_MAX_SOURCE_CHARS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("raises the ingest limit so a long document stays whole", () => {
    vi.stubEnv("LLMWIKI_MAX_SOURCE_CHARS", "250000");

    expect(resolveMaxSourceChars()).toBe(250_000);
    expect(enforceCharLimit("q".repeat(150_000)).truncated).toBe(false);
  });

  it("falls back to the default when the variable is unset or empty", () => {
    vi.stubEnv("LLMWIKI_MAX_SOURCE_CHARS", "");

    expect(resolveMaxSourceChars()).toBe(MAX_SOURCE_CHARS);
  });

  it("rejects a value below the minimum source length", () => {
    vi.stubEnv("LLMWIKI_MAX_SOURCE_CHARS", "12");

    expect(() => resolveMaxSourceChars()).toThrow(/LLMWIKI_MAX_SOURCE_CHARS/);
  });

  it("rejects a non-integer value", () => {
    vi.stubEnv("LLMWIKI_MAX_SOURCE_CHARS", "1.5");

    expect(() => resolveMaxSourceChars()).toThrow(/LLMWIKI_MAX_SOURCE_CHARS/);
  });
});
