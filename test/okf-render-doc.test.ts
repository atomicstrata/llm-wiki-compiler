import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { renderOkfDoc } from "../src/export/okf/render-doc.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { canonicalBody } from "../src/export/okf/mapping.js";
import type { ExportPage } from "../src/export/types.js";

const page = {
  title: "RAG", slug: "rag", pageDirectory: "concepts", path: "wiki/concepts/rag.md",
  summary: "Grounded.", sources: ["a.md"], tags: ["rag"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-02T00:00:00Z",
  links: ["other"], body: "See [[other]]. ^[a.md:1-3]", kind: "concept",
  citations: [{ file: "a.md", start: 1, end: 3 }], contentHash: "h", sourceHashes: [],
} as ExportPage;
const resolve = (s: string) => (s === "other" ? { dir: "concepts" as const, title: "Other" } : null);
const refName = (f: string) => (f === "a.md" ? "a-deadbeef.md" : null);

describe("renderOkfDoc", () => {
  it("emits conformant frontmatter (non-empty type) + rewritten links + verbatim ^[..] + # Citations + canonical contentHash", () => {
    const md = renderOkfDoc(page, resolve, refName);
    const { meta, body } = parseFrontmatter(md);
    expect(meta.type).toBe("concept");
    expect(body).toContain("[Other](/concepts/other.md)");
    expect(body).toContain("^[a.md:1-3]");
    expect(body).toContain("# Citations");
    expect((meta["x-llmwiki"] as { contentHash: string }).contentHash)
      .toBe(createHash("sha256").update(canonicalBody(page.body), "utf-8").digest("hex"));
  });
});
