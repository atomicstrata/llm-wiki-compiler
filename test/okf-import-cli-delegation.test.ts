// test/okf-import-cli-delegation.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import importCommand from "../src/commands/import.js";
import { listCandidates } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); });

describe("importCommand delegates to runOkfImport", () => {
  it("stages + prints a summary the CLI test relies on", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "icd-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
    await importCommand(dir, { okf: b });
    expect(await listCandidates(dir)).toHaveLength(1);
    expect(out.join("\n")).toMatch(/staged 1 page/i);
  });
});
