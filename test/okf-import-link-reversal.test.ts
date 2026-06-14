import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { importOkfBundle } from "../src/import/okf-import.js";
import { parseFrontmatter } from "../src/utils/markdown.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("intra-bundle link reversal (end-to-end via importOkfBundle)", () => {
  it("reverses a native link to a sibling into a wikilink matching the sibling's page slug", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-link-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    // rag.md is native (has x-llmwiki) and links to sibling vectors.md
    await writeFile(path.join(b, "concepts", "rag.md"),
      "---\ntype: concept\ntitle: RAG\nx-llmwiki:\n  schemaVersion: \"0.1\"\n  contentHash: h\n  pageDirectory: concepts\n---\n\nUses [Vectors](/concepts/vectors.md).\n");
    await writeFile(path.join(b, "concepts", "vectors.md"),
      "---\ntype: concept\ntitle: Vectors\nx-llmwiki:\n  schemaVersion: \"0.1\"\n  contentHash: h2\n  pageDirectory: concepts\n---\n\nText.\n");
    const { pages } = await importOkfBundle(b, dir);
    const rag = pages.find((p) => p.slug === "rag")!;
    const vectors = pages.find((p) => p.slug === "vectors")!;
    expect(vectors).toBeTruthy();
    const { body } = parseFrontmatter(rag.body);
    expect(body).toContain("[[vectors]]");        // reversed, text === title "Vectors"
    expect(body).not.toContain("/concepts/vectors.md"); // no leftover OKF link
  });
});
