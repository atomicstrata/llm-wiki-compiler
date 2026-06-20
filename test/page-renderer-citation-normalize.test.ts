/**
 * Integration test: `renderMergedPageContent` runs citation normalization.
 *
 * Verifies that when the LLM returns a bare line-number citation like `^[81]`,
 * `renderMergedPageContent` repairs or drops it before the page body is
 * assembled — so the returned markdown is free of viewer citation warnings.
 */

import { vi, describe, it, expect } from "vitest";
import { callClaude } from "../src/utils/llm.js";
import { renderMergedPageContent } from "../src/compiler/page-renderer.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeNumberedContent } from "./fixtures/citation-content.js";

vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(),
}));

/** Minimal SchemaConfig stub matching the shape page-renderer needs. */
const STUB_SCHEMA = { defaultKind: "concept" } as Parameters<typeof renderMergedPageContent>[2];

describe("renderMergedPageContent — citation normalization wired in", () => {
  it("repairs a bare ^[81] emitted by the LLM when the source has >= 81 lines", async () => {
    const source = "karpathy.md";
    const root = await makeTempRoot("page-renderer-normalize");
    const combinedContent = makeNumberedContent(source, 100);

    vi.mocked(callClaude).mockResolvedValue("Neural scaling laws.^[81]");

    const result = await renderMergedPageContent(
      root,
      {
        slug: "neural-scaling",
        concept: {
          concept: "Neural Scaling",
          summary: "How scale affects model quality.",
          is_new: false,
          tags: [],
        },
        sourceFiles: [source],
        combinedContent,
      },
      STUB_SCHEMA,
    );

    expect(result).toContain(`^[${source}:81]`);
    expect(result).not.toContain("^[81]");
  });

  it("drops a bare ^[99] when the source only has 40 lines", async () => {
    const source = "short.md";
    const root = await makeTempRoot("page-renderer-drop");
    const combinedContent = makeNumberedContent(source, 40);

    vi.mocked(callClaude).mockResolvedValue("Claim.^[99]");

    const result = await renderMergedPageContent(
      root,
      {
        slug: "short-concept",
        concept: {
          concept: "Short Concept",
          summary: "Short source only.",
          is_new: false,
          tags: [],
        },
        sourceFiles: [source],
        combinedContent,
      },
      STUB_SCHEMA,
    );

    expect(result).not.toContain("^[99]");
    expect(result).not.toContain("^[");
  });
});
