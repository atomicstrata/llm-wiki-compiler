import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import importCommand from "../src/commands/import.js";
import { listCandidates } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("import (default = stage candidates)", () => {
  it("stages each doc as an imported candidate and leaves wiki/ untouched", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-cmd-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    await importCommand(dir, { okf: b });
    const cands = await listCandidates(dir);
    expect(cands).toHaveLength(1);
    expect(cands[0].reviewMode).toBe("imported");
    expect(cands[0].heldReasons[0].code).toBe("imported-okf");
    expect(cands[0].targetDirectory).toBe("concepts");
    expect(cands[0].slug).toBe("a"); // concepts/ prefix stripped
    await expect(stat(path.join(dir, "wiki/concepts/a.md"))).rejects.toThrow();
  });
});
