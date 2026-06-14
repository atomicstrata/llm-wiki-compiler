import { describe, it, expect } from "vitest";
import { mkdir, writeFile, readFile, stat } from "fs/promises";
import path from "path";
import importCommand from "../src/commands/import.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { useOkfTempDir } from "./fixtures/okf-temp-dir.js";

const { make } = useOkfTempDir();

describe("import --trusted", () => {
  it("writes pages live with imported provenance and releases the lock", async () => {
    const dir = await make("okf-trust-");
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    await importCommand(dir, { okf: b, trusted: true });
    expect(await listCandidates(dir)).toHaveLength(0);
    const page = await readFile(path.join(dir, "wiki/concepts/a.md"), "utf-8");
    expect(page).toContain("provenanceState: imported");
    // The locked path must release `.llmwiki/lock` in its finally block.
    await expect(stat(path.join(dir, ".llmwiki/lock"))).rejects.toThrow();
  });
  it("skips a live-colliding slug even under --trusted", async () => {
    const dir = await make("okf-trust2-");
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/a.md"), "---\ntitle: Existing\n---\n\nKEEP.\n");
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nNEW.\n");
    await importCommand(dir, { okf: b, trusted: true });
    const page = await readFile(path.join(dir, "wiki/concepts/a.md"), "utf-8");
    expect(page).toContain("KEEP.");
  });
});
