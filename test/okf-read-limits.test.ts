import { describe, it, expect } from "vitest";
import { mkdir, writeFile, symlink } from "fs/promises";
import path from "path";
import { readOkfBundle } from "../src/import/okf-read.js";
import { useOkfTempDir } from "./fixtures/okf-temp-dir.js";

const { ctx, make } = useOkfTempDir();

async function bundle(): Promise<string> {
  const dir = await make("okf-read-");
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
    const docs = await readOkfBundle(b);
    expect(docs.map((d) => d.relPath)).toEqual(["concepts/a.md"]);
    expect(docs[0].meta.type).toBe("concept");
  });
  it("skips a doc whose path escapes the bundle via symlink", async () => {
    const b = await bundle();
    const outside = path.join(ctx.dir, "secret.md");
    await writeFile(outside, "---\ntype: concept\ntitle: S\n---\n\nx\n");
    await symlink(outside, path.join(b, "concepts", "link.md"));
    const docs = await readOkfBundle(b);
    expect(docs.map((d) => d.relPath)).toEqual(["concepts/a.md"]);
  });
  it("rejects a bundle exceeding the file cap", async () => {
    const b = await bundle();
    for (let i = 0; i < 5; i++) await writeFile(path.join(b, "concepts", `f${i}.md`), "---\ntype: concept\ntitle: F\n---\n\nx\n");
    await expect(readOkfBundle(b, { maxFiles: 3 })).rejects.toThrow(/file/i);
  });
  it("rejects (not truncates) a doc exceeding the per-doc byte cap", async () => {
    const dir = await make("okf-bytes-");
    const b = path.join(dir, "bundle"); await mkdir(b, { recursive: true });
    const big = "---\ntype: concept\ntitle: Big\n---\n\n" + "x".repeat(5000) + "\n";
    await writeFile(path.join(b, "big.md"), big);
    await expect(readOkfBundle(b, { maxDocBytes: 100 })).rejects.toThrow(/size|limit/i);
  });
});
