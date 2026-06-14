import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { filterCollisions } from "../src/import/okf-collision.js";
import type { MappedOkfPage } from "../src/import/types.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const page = (slug: string, okfPath: string): MappedOkfPage =>
  ({ slug, title: slug, summary: "", sources: [], targetDirectory: "concepts", okfPath, body: "x" });

describe("filterCollisions", () => {
  it("drops a slug that already exists live, keeps the rest", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-col-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/dup.md"), "---\ntitle: D\n---\n\nx\n");
    const { kept, skipped } = await filterCollisions(dir, [page("dup", "concepts/dup.md"), page("fresh", "concepts/fresh.md")]);
    expect(kept.map((p) => p.slug)).toEqual(["fresh"]);
    expect(skipped[0]).toMatchObject({ slug: "dup", reason: "live-page" });
  });
  it("drops the second of two intra-import docs sharing a slug", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-col2-"));
    const { kept, skipped } = await filterCollisions(dir, [page("same", "a/same.md"), page("same", "b/same.md")]);
    expect(kept).toHaveLength(1);
    expect(kept[0].okfPath).toBe("a/same.md");
    expect(skipped[0]).toMatchObject({ slug: "same", reason: "duplicate-in-bundle" });
  });
});
