import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { importOkfBundle } from "../src/import/okf-import.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("importOkfBundle", () => {
  it("reads, maps, and collision-filters a bundle into mapped pages", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-orch-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "index.md"), "---\nokf_version: \"0.1\"\n---\n# kb\n");
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const { pages, skipped } = await importOkfBundle(b, dir);
    expect(pages.map((p) => p.slug)).toEqual(["a"]);
    expect(pages[0].sources).toContain("okf:kb");
    expect(skipped).toHaveLength(0);
  });
});
