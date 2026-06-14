import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import importCommand from "../src/commands/import.js";
import { listCandidates } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { process.exitCode = 0; if (dir) await rm(dir, { recursive: true, force: true }); });

describe("import --dry-run", () => {
  it("writes nothing (no candidates, no wiki file, no lock) for a valid bundle", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-dry-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    await importCommand(dir, { okf: b, dryRun: true });
    expect(await listCandidates(dir)).toHaveLength(0);
    await expect(stat(path.join(dir, "wiki/concepts/a.md"))).rejects.toThrow();
    await expect(stat(path.join(dir, ".llmwiki/lock"))).rejects.toThrow();
  });
});
