// test/okf-run-import.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { assertNoOutput } from "./fixtures/no-output.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
async function bundle(root: string): Promise<string> {
  const b = path.join(root, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
  await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
  return b;
}

describe("runOkfImport", () => {
  it("stages by default and returns a staged report (no stdout)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rii-"));
    const b = await bundle(dir);
    const report = await assertNoOutput(() => runOkfImport(dir, b, {}));
    expect(report.mode).toBe("staged");
    expect(report.pages).toEqual([{ slug: "a", okfPath: "concepts/a.md", targetDirectory: "concepts" }]);
    expect(await listCandidates(dir)).toHaveLength(1);
  });
  it("dry-run writes/stages nothing and reports would-import", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rii2-"));
    const b = await bundle(dir);
    const report = await runOkfImport(dir, b, { dryRun: true });
    expect(report.mode).toBe("dry-run");
    expect(report.pages).toHaveLength(1);
    expect(await listCandidates(dir)).toHaveLength(0);
  });
  it("trusted writes live", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rii3-"));
    const b = await bundle(dir);
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.mode).toBe("written");
    expect((await stat(path.join(dir, "wiki/concepts/a.md"))).isFile()).toBe(true);
    expect(await readFile(path.join(dir, "wiki/concepts/a.md"), "utf-8")).toContain("provenanceState: imported");
  });
});
