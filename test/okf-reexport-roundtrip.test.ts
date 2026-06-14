import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectExportPages } from "../src/export/collect.js";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { importOkfBundle } from "../src/import/okf-import.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** Stage a mapped import page into a fresh project's wiki/concepts/, then return its slug. */
async function stageImported(root: string, slug: string, body: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(root, `wiki/concepts/${slug}.md`), body);
}

const FOREIGN_DOC = "---\ntype: BigQuery Table\ntitle: Cust\nvendorKey: 7\n---\n\nA table.\n";

describe("OKF re-export honesty round-trips", () => {
  it("reproduces an unknown foreign type + key verbatim through import -> export", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-rx-foreign-"));
    const bundleDir = path.join(dir, "foreign");
    await mkdir(path.join(bundleDir, "concepts"), { recursive: true });
    await writeFile(path.join(bundleDir, "concepts/t.md"), FOREIGN_DOC);
    const proj = path.join(dir, "proj");
    const { pages } = await importOkfBundle(bundleDir, proj);
    await stageImported(proj, pages[0].slug, pages[0].body);
    const exp = await collectExportPages(proj);
    const outDir = path.join(dir, "out");
    await buildOkfBundle(proj, exp, outDir);
    const doc = await readFile(path.join(outDir, `concepts/${pages[0].slug}.md`), "utf-8");
    const { meta } = parseFrontmatter(doc);
    expect(meta.type).toBe("BigQuery Table");
    expect(meta.vendorKey).toBe(7);
    expect(meta["x-llmwiki"]).toBeDefined();
  });

  it("regenerates exactly one # Citations section across export -> import -> export", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-rx-cite-"));
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(proj, "wiki/concepts/rag.md"),
      "---\ntitle: RAG\nkind: concept\nsources: [rag.md]\n---\n\nText. ^[rag.md:1-2]\n");
    const expA = await collectExportPages(proj);
    const outA = path.join(dir, "outA");
    await buildOkfBundle(proj, expA, outA);
    const docA = await readFile(path.join(outA, "concepts/rag.md"), "utf-8");
    expect((docA.match(/^#\s+Citations\b/gm) ?? []).length).toBe(1);
    const proj2 = path.join(dir, "proj2");
    const { pages } = await importOkfBundle(outA, proj2);
    await stageImported(proj2, pages[0].slug, pages[0].body);
    const expB = await collectExportPages(proj2);
    const outB = path.join(dir, "outB");
    await buildOkfBundle(proj2, expB, outB);
    const docB = await readFile(path.join(outB, `concepts/${pages[0].slug}.md`), "utf-8");
    expect((docB.match(/^#\s+Citations\b/gm) ?? []).length).toBe(1);
  });
});
