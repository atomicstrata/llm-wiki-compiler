import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { readOkfBundle } from "../src/import/okf-read.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function bundle(): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "okf-read-"));
  const b = path.join(dir, "bundle");
  await mkdir(path.join(b, "concepts"), { recursive: true });
  await writeFile(path.join(b, "index.md"), "---\nokf_version: \"0.1\"\n---\n# B\n");
  await writeFile(path.join(b, "log.md"), "# Log\n");
  await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody A.\n");
  return b;
}

describe("readOkfBundle", () => {
  it("returns non-reserved docs, skipping index.md/log.md", async () => {
    const b = await bundle();
    const docs = await readOkfBundle(b, dir);
    expect(docs.map((d) => d.relPath)).toEqual(["concepts/a.md"]);
    expect(docs[0].meta.type).toBe("concept");
  });
  it("skips a doc whose path escapes the bundle via symlink", async () => {
    const b = await bundle();
    const outside = path.join(dir, "secret.md");
    await writeFile(outside, "---\ntype: concept\ntitle: S\n---\n\nx\n");
    await symlink(outside, path.join(b, "concepts", "link.md"));
    const docs = await readOkfBundle(b, dir);
    expect(docs.map((d) => d.relPath)).toEqual(["concepts/a.md"]);
  });
  it("rejects a bundle exceeding the file cap", async () => {
    const b = await bundle();
    for (let i = 0; i < 5; i++) await writeFile(path.join(b, "concepts", `f${i}.md`), "---\ntype: concept\ntitle: F\n---\n\nx\n");
    await expect(readOkfBundle(b, dir, { maxFiles: 3 })).rejects.toThrow(/file/i);
  });
});
