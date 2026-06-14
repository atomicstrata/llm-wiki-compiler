import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import importCommand from "../src/commands/import.js";
import { listCandidates } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("import --trusted", () => {
  it("writes pages live with imported provenance and no candidates", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-trust-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    await importCommand(dir, { okf: b, trusted: true });
    expect(await listCandidates(dir)).toHaveLength(0);
    const page = await readFile(path.join(dir, "wiki/concepts/a.md"), "utf-8");
    expect(page).toContain("provenanceState: imported");
  });
  it("skips a live-colliding slug even under --trusted", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-trust2-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/a.md"), "---\ntitle: Existing\n---\n\nKEEP.\n");
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nNEW.\n");
    await importCommand(dir, { okf: b, trusted: true });
    const page = await readFile(path.join(dir, "wiki/concepts/a.md"), "utf-8");
    expect(page).toContain("KEEP.");
  });
});
