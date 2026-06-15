// test/okf-sdk.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { createWiki } from "../src/index.js";
import { listCandidates } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("SDK OKF methods", () => {
  it("exportOkf writes a bundle; importOkf stages by default; dryRun stages nothing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sdk-okf-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/rag.md"), "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n");
    const wiki = createWiki({ root: dir });
    const exp = await wiki.exportOkf({ out: path.join(dir, "out") });
    expect((await stat(path.join(exp.outDir, "index.md"))).isFile()).toBe(true);

    const bundle = path.join(dir, "kb"); await mkdir(path.join(bundle, "concepts"), { recursive: true });
    await writeFile(path.join(bundle, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const staged = await wiki.importOkf(bundle);
    expect(staged.mode).toBe("staged");
    expect(await listCandidates(dir)).toHaveLength(1);

    const preview = await wiki.importOkf(bundle, { dryRun: true });
    expect(preview.mode).toBe("dry-run");
    expect(await listCandidates(dir)).toHaveLength(1); // dry-run added nothing
  });
});
