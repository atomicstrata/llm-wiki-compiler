import { describe, it, expect } from "vitest";
import { buildOkfIndex, buildOkfLog, parseLlmwikiLog } from "../src/export/okf/index-log.js";
import type { ExportPage } from "../src/export/types.js";

const pages = [
  { title: "RAG", slug: "rag", pageDirectory: "concepts", summary: "Grounded." },
  { title: "Q1", slug: "q1", pageDirectory: "queries", summary: "An answer." },
] as ExportPage[];

describe("OKF index + log", () => {
  it("index has root okf_version frontmatter and a TOC over BOTH dirs", () => {
    const idx = buildOkfIndex(pages);
    expect(idx).toMatch(/^---\n[\s\S]*okf_version:\s*["']?0\.1/m);
    expect(idx).toContain("* [RAG](/concepts/rag.md) - Grounded.");
    expect(idx).toContain("* [Q1](/queries/q1.md) - An answer.");
  });
  it("log groups entries by ISO date, newest first, with bold action prefix", () => {
    const log = buildOkfLog([{ date: "2026-02-02", action: "Export", text: "12 docs" }]);
    expect(log).toContain("## 2026-02-02");
    expect(log).toContain("**Export** 12 docs");
  });
  it("translates llmwiki log.md headings into OKF entries (newest first, capitalized action)", () => {
    const llmwiki = `## [2026-02-02T09:14:02Z] ingest | "Doc A"\n- detail\n\n## [2026-02-01T08:00:00Z] compile | 1 source(s)\n`;
    const log = buildOkfLog(parseLlmwikiLog(llmwiki));
    expect(log.indexOf("## 2026-02-02")).toBeLessThan(log.indexOf("## 2026-02-01"));
    expect(log).toContain('**Ingest** "Doc A"');
    expect(log).toContain("**Compile** 1 source(s)");
  });
});
