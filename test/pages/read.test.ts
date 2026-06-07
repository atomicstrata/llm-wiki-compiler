import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPageRecord } from "../../src/pages/read.js";

describe("readPageRecord", () => {
  it("reads a concept page and skips orphaned pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-read-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/foo.md"), "---\ntitle: Foo\nsummary: s\n---\nbody", "utf-8");
    const page = await readPageRecord(root, "foo");
    expect(page?.title).toBe("Foo");
    expect(page?.body).toContain("body");
  });
});
