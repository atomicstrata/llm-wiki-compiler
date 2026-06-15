import { describe, it, expect } from "vitest";
import { resolveOutputPaths, isSafeOkfPath } from "../src/export/okf/output-paths.js";
import type { ExportPage } from "../src/export/types.js";

const page = (slug: string, dir: "concepts" | "queries", okfPath?: string): ExportPage =>
  ({ slug, pageDirectory: dir, title: slug, summary: "", body: "", ...(okfPath ? { xOkf: { okfPath, originalFrontmatter: {} } } : {}) } as ExportPage);

describe("resolveOutputPaths", () => {
  it("native pages use slug-paths; a safe foreign okfPath is restored", () => {
    const pages = [page("rag", "concepts"), page("tables-customers", "concepts", "tables/customers.md")];
    const { paths, warnings } = resolveOutputPaths(pages, "/out");
    expect(paths.get(pages[0])).toBe("concepts/rag.md");
    expect(paths.get(pages[1])).toBe("tables/customers.md");
    expect(warnings).toHaveLength(0);
  });
  it("an unsafe okfPath falls back to slug-path + warns", () => {
    const pages = [page("x", "concepts", "../escape.md")];
    const { paths, warnings } = resolveOutputPaths(pages, "/out");
    expect(paths.get(pages[0])).toBe("concepts/x.md");
    expect(warnings[0]).toMatch(/not restorable/i);
  });
  it("a foreign okfPath that is a NATIVE page's slug-path is rejected; neither is lost", () => {
    const a = page("customers", "concepts");                      // native, slug-path concepts/customers.md
    const b = page("b", "concepts", "concepts/customers.md");     // foreign, wants A's slug-path
    const { paths } = resolveOutputPaths([a, b], "/out");
    expect(paths.get(a)).toBe("concepts/customers.md");
    expect(paths.get(b)).toBe("concepts/b.md");
  });
  it("a foreign okfPath equal to ANOTHER FOREIGN page's fallback slug-path is rejected; both keep a path", () => {
    const a = page("customers", "concepts", "../bad.md");         // foreign, unsafe okfPath → falls back to concepts/customers.md
    const b = page("b", "concepts", "concepts/customers.md");     // foreign, wants A's (fallback) slug-path
    const { paths } = resolveOutputPaths([a, b], "/out");
    expect(paths.get(a)).toBe("concepts/customers.md");          // A's reserved slug-path is never stolen
    expect(paths.get(b)).toBe("concepts/b.md");                  // B falls back to its own
  });
  it("isSafeOkfPath rejects reserved/escape/absolute, allows nested index.md", () => {
    expect(isSafeOkfPath("index.md", "/out")).toBe(false);
    expect(isSafeOkfPath("references/x.md", "/out")).toBe(false);
    expect(isSafeOkfPath("/abs.md", "/out")).toBe(false);
    expect(isSafeOkfPath("a/../../b.md", "/out")).toBe(false);
    expect(isSafeOkfPath("tables/index.md", "/out")).toBe(true);
    expect(isSafeOkfPath("tables/customers.md", "/out")).toBe(true);
  });
});
