import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { mapPageToOkfFrontmatter } from "../src/export/okf/mapping.js";
import type { ExportPage } from "../src/export/types.js";

const sha = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
function page(overrides: Partial<ExportPage> = {}): ExportPage {
  return {
    title: "RAG", slug: "rag", pageDirectory: "concepts", path: "wiki/concepts/rag.md",
    summary: "Grounded generation.", sources: ["rag.md"], tags: ["rag"],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-02T00:00:00Z",
    links: [], body: "Body.", kind: "concept", advisoryConfidence: 0.86,
    citations: [{ file: "rag.md", start: 1, end: 3 }], contentHash: "abc",
    sourceHashes: [], ...overrides,
  } as ExportPage;
}

describe("mapPageToOkfFrontmatter", () => {
  it("maps standard fields + provenance; contentHash is over the canonical body; marks pageDirectory", () => {
    const fm = mapPageToOkfFrontmatter(page({ body: "Body." }));
    expect(fm.type).toBe("concept");
    expect(fm.title).toBe("RAG");
    expect(fm.description).toBe("Grounded generation.");
    expect(fm.timestamp).toBe("2026-02-02T00:00:00Z");
    expect(fm["x-llmwiki"]).toMatchObject({
      schemaVersion: "0.1", pageDirectory: "concepts", confidence: 0.86,
      sources: ["rag.md"], citations: [{ file: "rag.md", start: 1, end: 3 }],
    });
    expect(fm["x-llmwiki"].contentHash).toBe(sha("Body.\n"));
  });
  it("defaults type to concept when kind absent; queries marked via pageDirectory", () => {
    expect(mapPageToOkfFrontmatter(page({ kind: undefined })).type).toBe("concept");
    expect(mapPageToOkfFrontmatter(page({ pageDirectory: "queries" }))["x-llmwiki"].pageDirectory).toBe("queries");
  });
});
