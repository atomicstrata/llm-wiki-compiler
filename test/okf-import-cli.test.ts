import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runCLI } from "./fixtures/run-cli.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("llmwiki import --okf (subprocess)", () => {
  it("stages candidates from a bundle via the built binary", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-cli-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const result = await runCLI(["import", "--okf", b], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/staged 1 page/i);
  });
});
