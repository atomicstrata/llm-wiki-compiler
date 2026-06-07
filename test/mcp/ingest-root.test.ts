import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestSource } from "../../src/commands/ingest.js";

describe("ingestSource is root-explicit", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("writes under the passed root even when process.cwd() is elsewhere", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-root-"));
    const foreign = await mkdtemp(path.join(tmpdir(), "wiki-cwd-"));
    process.chdir(foreign);
    const local = path.join(root, "fixture.txt");
    await writeFile(local, "hello body text", "utf-8");
    await ingestSource(root, local);
    const files = await readdir(path.join(root, "sources"));
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
    await expect(readdir(path.join(foreign, "sources"))).rejects.toThrow();
  });
});
