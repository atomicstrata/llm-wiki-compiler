// test/okf-run-export.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfExport } from "../src/export/okf/run.js";
import { assertNoOutput } from "./fixtures/no-output.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("runOkfExport", () => {
  it("writes a bundle and returns outDir + paths (no stdout)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rxe-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/rag.md"), "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n");
    const report = await assertNoOutput(() => runOkfExport(dir, { out: path.join(dir, "out") }));
    expect(report.outDir).toBe(path.join(dir, "out"));
    expect(report.writtenPaths.length).toBeGreaterThan(0);
    expect((await stat(path.join(dir, "out/index.md"))).isFile()).toBe(true);
  });
});
