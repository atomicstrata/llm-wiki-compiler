import { describe, it, expect } from "vitest";
import { stat, readFile } from "fs/promises";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { makeExportPage } from "./fixtures/okf-export-page.js";
import { useOkfTempDir } from "./fixtures/okf-temp-dir.js";

const { make } = useOkfTempDir();
const page = (slug: string, dirn: "concepts" | "queries", body: string, okfPath?: string) =>
  makeExportPage(slug, { pageDirectory: dirn, body, okfPath });

describe("nested-path export", () => {
  it("writes a foreign doc at its okfPath and the index links there", async () => {
    const dir = await make("okf-nest-");
    const out = path.join(dir, "bundle");
    const pages = [page("tables-customers", "concepts", "Body.\n", "tables/customers.md")];
    await buildOkfBundle(dir, pages, out);
    expect((await stat(path.join(out, "tables/customers.md"))).isFile()).toBe(true);
    expect(await stat(path.join(out, "concepts/tables-customers.md")).then(() => true, () => false)).toBe(false);
    expect(await readFile(path.join(out, "index.md"), "utf-8")).toContain("(/tables/customers.md)");
  });
  it("a native page linking a foreign doc emits the foreign doc's real path", async () => {
    const dir = await make("okf-nest2-");
    const out = path.join(dir, "bundle");
    const pages = [
      page("home", "concepts", "See [[tables-customers]].\n"),
      page("tables-customers", "concepts", "Body.\n", "tables/customers.md"),
    ];
    await buildOkfBundle(dir, pages, out);
    expect(await readFile(path.join(out, "concepts/home.md"), "utf-8")).toContain("(/tables/customers.md)");
  });
});
