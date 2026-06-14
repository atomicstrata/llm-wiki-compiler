import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectExportPages } from "../src/export/collect.js";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { importOkfBundle } from "../src/import/okf-import.js";
import { canonicalBody } from "../src/export/okf/mapping.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function seedWiki(root: string): Promise<void> {
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  await writeFile(path.join(root, "wiki/concepts/rag.md"),
    "---\ntitle: RAG\nsummary: retrieval\nkind: concept\nconfidence: 0.9\nsources: [rag.md]\naliases: [rag]\n---\n\nText. ^[rag.md:1-2]\n");
  await writeFile(path.join(root, "wiki/queries/trends.md"),
    "---\ntitle: Trends\nsummary: q\nkind: overview\n---\n\nSee [[rag]].\n");
}

describe("OKF native round-trip (export -> import)", () => {
  it("preserves canonical body (byte-equal), kind, sources, and query targetDirectory", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-rt-"));
    await seedWiki(dir);
    const pages = await collectExportPages(dir);
    const out = path.join(dir, "bundle");
    await buildOkfBundle(dir, pages, out);
    const { pages: imported } = await importOkfBundle(out, path.join(dir, "fresh-project"));
    const rag = imported.find((p) => p.slug === "rag")!;
    const { meta, body } = parseFrontmatter(rag.body);
    const original = pages.find((p) => p.slug === "rag")!;
    expect(canonicalBody(body)).toBe(canonicalBody(original.body));
    expect(meta.kind).toBe("concept");
    expect((meta.sources as string[]).filter((s) => !s.startsWith("okf:"))).toEqual(["rag.md"]);
    expect(body).toContain("^[rag.md:1-2]");
    const trends = imported.find((p) => p.slug === "trends")!;
    expect(trends.targetDirectory).toBe("queries");
  });
});
