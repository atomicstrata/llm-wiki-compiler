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
  // B is foreign and wants concepts/customers.md (A's slug-path); A must keep it, B must fall back.
  const expectCollisionRejected = (a: ExportPage) => {
    const b = page("b", "concepts", "concepts/customers.md");
    const { paths } = resolveOutputPaths([a, b], "/out");
    expect(paths.get(a)).toBe("concepts/customers.md"); // A's reserved slug-path is never stolen
    expect(paths.get(b)).toBe("concepts/b.md");         // B falls back to its own
  };
  it("a foreign okfPath that is a NATIVE page's slug-path is rejected; neither is lost", () => {
    expectCollisionRejected(page("customers", "concepts")); // native owner of concepts/customers.md
  });
  it("a foreign okfPath equal to ANOTHER FOREIGN page's fallback slug-path is rejected; both keep a path", () => {
    expectCollisionRejected(page("customers", "concepts", "../bad.md")); // foreign, unsafe okfPath → falls back to concepts/customers.md
  });
  it("isSafeOkfPath rejects reserved/escape/absolute, allows nested index.md", () => {
    expect(isSafeOkfPath("index.md", "/out")).toBe(false);
    expect(isSafeOkfPath("references/x.md", "/out")).toBe(false);
    expect(isSafeOkfPath("/abs.md", "/out")).toBe(false);
    expect(isSafeOkfPath("a/../../b.md", "/out")).toBe(false);
    expect(isSafeOkfPath("./index.md", "/out")).toBe(false);
    expect(isSafeOkfPath("a/./b.md", "/out")).toBe(false);
    expect(isSafeOkfPath("tables/index.md", "/out")).toBe(true);
    expect(isSafeOkfPath("tables/customers.md", "/out")).toBe(true);
  });
  it("isSafeOkfPath rejects URL-unsafe characters (spaces/parens would yield malformed links)", () => {
    expect(isSafeOkfPath("tables/my customers.md", "/out")).toBe(false); // space truncates link URL
    expect(isSafeOkfPath("report (2024).md", "/out")).toBe(false);       // paren closes link early
    expect(isSafeOkfPath("tables/customers.md", "/out")).toBe(true);     // still safe
    expect(isSafeOkfPath("a/../../b.md", "/out")).toBe(false);           // still rejected
  });
  it("isSafeOkfPath rejects non-.md / directory-like targets (importer only round-trips .md docs)", () => {
    expect(isSafeOkfPath("tables/customers", "/out")).toBe(false); // no extension
    expect(isSafeOkfPath("tables/", "/out")).toBe(false);          // directory-like
    expect(isSafeOkfPath("tables/customers.md", "/out")).toBe(true);
  });
  it("a foreign okfPath that is not a .md document falls back to its slug-path + warns", () => {
    const pages = [page("customers", "concepts", "tables/customers")];
    const { paths, warnings } = resolveOutputPaths(pages, "/out");
    expect(paths.get(pages[0])).toBe("concepts/customers.md");
    expect(warnings[0]).toMatch(/not restorable/i);
  });
  it("a foreign okfPath with URL-unsafe chars falls back to its slug-path + warns", () => {
    const pages = [page("my-customers", "concepts", "tables/my customers.md")];
    const { paths, warnings } = resolveOutputPaths(pages, "/out");
    expect(paths.get(pages[0])).toBe("concepts/my-customers.md");
    expect(warnings[0]).toMatch(/not restorable/i);
  });
  it("two foreign pages sharing an okfPath resolve deterministically regardless of input order", () => {
    const a = page("a-slug", "concepts", "tables/dup.md");
    const b = page("b-slug", "concepts", "tables/dup.md");
    const forward = resolveOutputPaths([a, b], "/out").paths;
    const reversed = resolveOutputPaths([b, a], "/out").paths;
    expect(forward.get(a)).toBe("tables/dup.md"); // a wins the okfPath (sorts before b by slug)
    expect(reversed.get(a)).toBe("tables/dup.md"); // SAME page wins regardless of order
    expect(forward.get(b)).toBe("concepts/b-slug.md");
    expect(reversed.get(b)).toBe("concepts/b-slug.md");
  });
});
