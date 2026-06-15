// test/okf-read-onwarn.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { readOkfBundle } from "../src/import/okf-read.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("readOkfBundle onWarn collector", () => {
  it("routes skip warnings to onWarn instead of printing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-onwarn-"));
    const b = path.join(dir, "bundle"); await mkdir(b, { recursive: true });
    await writeFile(path.join(b, "bad.md"), "---\ntitle: no type\n---\n\nx\n"); // typeless → skipped+warned
    await writeFile(path.join(b, "ok.md"), "---\ntype: concept\ntitle: Y\n---\n\ny\n");
    const warnings: string[] = [];
    const docs = await readOkfBundle(b, {}, (m) => warnings.push(m));
    expect(docs.map((d) => d.relPath)).toEqual(["ok.md"]);
    expect(warnings.some((w) => w.includes("bad.md"))).toBe(true);
  });
});
