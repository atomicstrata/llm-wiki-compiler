import { describe, it, expect } from "vitest";
import { okfDocToPage } from "../src/import/okf-map.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

const ctx = { bundleId: "demo", titleOf: (s: string) => (s === "rag" ? "RAG" : null) };

describe("okfDocToPage", () => {
  it("maps a native concept doc, preserving x-llmwiki + reversing links + imported provenance", () => {
    const doc = {
      relPath: "concepts/rag.md",
      meta: { type: "concept", title: "RAG", description: "d", tags: ["t"], timestamp: "2026-01-01T00:00:00Z",
        "x-llmwiki": { schemaVersion: "0.1", contentHash: "h", pageDirectory: "concepts",
          sources: ["rag-paper.md"], confidence: 0.9, aliases: ["rag"] } },
      body: "Body cites [RAG](/concepts/rag.md). ^[rag-paper.md:1-2]\n",
    };
    const page = okfDocToPage(doc, ctx);
    expect(page.slug).toBe("rag");
    expect(page.targetDirectory).toBe("concepts");
    const { meta, body } = parseFrontmatter(page.body);
    expect(meta.kind).toBe("concept");
    expect(meta.confidence).toBe(0.9);
    expect(meta.provenanceState).toBe("imported");
    expect(meta.sources).toContain("okf:demo");
    expect(meta.sources).toContain("rag-paper.md");
    expect(body).toContain("[[rag]]");
    expect(body).toContain("^[rag-paper.md:1-2]");
  });
  it("keeps exactly one okf: origin token across repeated round-trips", () => {
    const doc = {
      relPath: "concepts/rag.md",
      meta: { type: "concept", title: "RAG",
        "x-llmwiki": { schemaVersion: "0.1", contentHash: "h", pageDirectory: "concepts",
          sources: ["rag-paper.md", "okf:old"] } },
      body: "Body.\n",
    };
    const { meta } = parseFrontmatter(okfDocToPage(doc, ctx).body);
    const okfTokens = (meta.sources as string[]).filter((s) => s.startsWith("okf:"));
    expect(okfTokens).toEqual(["okf:demo"]);
    expect(meta.sources).toContain("rag-paper.md");
  });
  it("does not promote untrusted aliases/contradictedBy to active frontmatter", () => {
    const doc = {
      relPath: "concepts/rag.md",
      meta: { type: "concept", title: "RAG",
        "x-llmwiki": { schemaVersion: "0.1", contentHash: "h", pageDirectory: "concepts",
          confidence: 0.7, aliases: ["hijack"], contradictedBy: [{ slug: "victim" }] } },
      body: "Body.\n",
    };
    const { meta } = parseFrontmatter(okfDocToPage(doc, ctx).body);
    expect(meta.aliases).toBeUndefined();
    expect(meta.contradictedBy).toBeUndefined();
    expect(meta.confidence).toBe(0.7); // advisory; still promoted
    const snapshot = (meta["x-okf"] as any).originalFrontmatter["x-llmwiki"];
    expect(snapshot.aliases).toEqual(["hijack"]); // preserved losslessly in snapshot
    expect(snapshot.contradictedBy).toEqual([{ slug: "victim" }]);
  });
  it("unknown type -> kind concept + x-okf.type, foreign body kept verbatim", () => {
    const doc = { relPath: "t.md", meta: { type: "BigQuery Table", vendorKey: 7 }, body: "See [x](/concepts/missing.md).\n" };
    const page = okfDocToPage(doc, { bundleId: "b", titleOf: () => null });
    const { meta, body } = parseFrontmatter(page.body);
    expect(meta.kind).toBe("concept");
    expect((meta["x-okf"] as any).type).toBe("BigQuery Table");
    expect((meta["x-okf"] as any).originalFrontmatter.vendorKey).toBe(7);
    expect(body).toContain("/concepts/missing.md");
  });
  it("records the source relPath durably under x-okf.okfPath", () => {
    const doc = { relPath: "concepts/t.md", meta: { type: "BigQuery Table" }, body: "Body.\n" };
    const { meta } = parseFrontmatter(okfDocToPage(doc, { bundleId: "b", titleOf: () => null }).body);
    expect((meta["x-okf"] as any).okfPath).toBe("concepts/t.md");
  });
});
