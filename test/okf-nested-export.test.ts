import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import type { ExportPage } from "../src/export/types.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const page = (slug: string, dirn: "concepts" | "queries", body: string, okfPath?: string): ExportPage =>
  ({ slug, pageDirectory: dirn, title: slug, summary: "s", sources: [], tags: [], createdAt: "", updatedAt: "",
     links: [], body, citations: [], freshnessStatus: "unverified", contradicted: false, archived: false,
     contentHash: "", sourceHashes: [], path: "", ...(okfPath ? { xOkf: { okfPath, originalFrontmatter: {} } } : {}) } as ExportPage);

describe("nested-path export", () => {
  it("writes a foreign doc at its okfPath and the index links there", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-nest-"));
    const out = path.join(dir, "bundle");
    const pages = [page("tables-customers", "concepts", "Body.\n", "tables/customers.md")];
    await buildOkfBundle(dir, pages, out);
    expect((await stat(path.join(out, "tables/customers.md"))).isFile()).toBe(true);
    expect(await stat(path.join(out, "concepts/tables-customers.md")).then(() => true, () => false)).toBe(false);
    expect(await readFile(path.join(out, "index.md"), "utf-8")).toContain("(/tables/customers.md)");
  });
  it("a native page linking a foreign doc emits the foreign doc's real path", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-nest2-"));
    const out = path.join(dir, "bundle");
    const pages = [
      page("home", "concepts", "See [[tables-customers]].\n"),
      page("tables-customers", "concepts", "Body.\n", "tables/customers.md"),
    ];
    await buildOkfBundle(dir, pages, out);
    expect(await readFile(path.join(out, "concepts/home.md"), "utf-8")).toContain("(/tables/customers.md)");
  });
});
