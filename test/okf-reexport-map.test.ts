import { describe, it, expect } from "vitest";
import { mapPageToOkfFrontmatter } from "../src/export/okf/mapping.js";
import type { ExportPage } from "../src/export/types.js";

function page(overrides: Partial<ExportPage> = {}): ExportPage {
  return {
    title: "T", slug: "t", pageDirectory: "concepts", path: "wiki/concepts/t.md",
    summary: "", sources: [], tags: [], createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-02T00:00:00Z", links: [], body: "A table.\n", kind: "concept",
    citations: [], contentHash: "abc", sourceHashes: [], ...overrides,
  } as ExportPage;
}

describe("mapPageToOkfFrontmatter reconstructs foreign frontmatter", () => {
  it("reproduces foreign type + keys and refreshes x-llmwiki for imported pages", () => {
    const fm = mapPageToOkfFrontmatter(page({
      xOkf: {
        type: "BigQuery Table",
        originalFrontmatter: {
          type: "BigQuery Table", title: "T", vendorKey: 7,
          "x-llmwiki": { schemaVersion: "0.1", contentHash: "STALE", pageDirectory: "concepts" },
        },
      },
    }));
    expect(fm.type).toBe("BigQuery Table");
    expect((fm as Record<string, unknown>).vendorKey).toBe(7);
    expect(fm["x-llmwiki"].contentHash).not.toBe("STALE");
    expect(fm["x-llmwiki"].pageDirectory).toBe("concepts");
  });

  it("falls through to the native path when xOkf is absent", () => {
    expect(mapPageToOkfFrontmatter(page({ kind: undefined })).type).toBe("concept");
  });
});
