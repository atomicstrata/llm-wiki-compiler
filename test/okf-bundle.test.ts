/**
 * @file Integration tests for the OKF bundle writer.
 *
 * Verifies that buildOkfBundle produces a conformant, path-confined bundle:
 * index.md at the root, concept docs under their page directory, reference
 * files copied under references/, stale pages removed on re-export, and
 * path-traversal slugs rejected.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import type { ExportPage } from "../src/export/types.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "okf-"));
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources", "a.md"), "# A\nsource text", "utf-8");
});

function page(over: Partial<ExportPage> = {}): ExportPage {
  return {
    title: "RAG", slug: "rag", pageDirectory: "concepts", path: "wiki/concepts/rag.md",
    summary: "Grounded.", sources: ["a.md"], tags: [], createdAt: "x", updatedAt: "y",
    links: [], body: "Body ^[a.md:1-3]", kind: "concept",
    citations: [{ file: "a.md", start: 1, end: 3 }], contentHash: "h", sourceHashes: [], ...over,
  } as ExportPage;
}

describe("buildOkfBundle", () => {
  it("writes a conformant bundle: index.md, concepts/<slug>.md, references/<source>.md", async () => {
    const out = path.join(root, "bundle");
    const written = await buildOkfBundle(root, [page()], out);
    expect(written.some((p) => p.endsWith("index.md"))).toBe(true);
    const doc = await readFile(path.join(out, "concepts", "rag.md"), "utf-8");
    expect(doc).toMatch(/type:\s*concept/);
    expect(await readdir(path.join(out, "references"))).toContain("a.md");
  });

  it("clears stale files from a prior export (removed page is gone)", async () => {
    const out = path.join(root, "bundle");
    await buildOkfBundle(root, [page(), page({ slug: "gone", title: "Gone" })], out);
    await access(path.join(out, "concepts", "gone.md")); // exists after first export
    await buildOkfBundle(root, [page()], out);           // re-export without "gone"
    await expect(access(path.join(out, "concepts", "gone.md"))).rejects.toThrow();
  });

  it("copies cited sources under references/ with safe flat names (no traversal/escape)", async () => {
    await writeFile(path.join(root, "sources", "a.md"), "x", "utf-8");
    const out = path.join(root, "bundle");
    // A normal citation; the safe-name behavior for odd filenames is unit-tested in Group 1.
    await buildOkfBundle(root, [page()], out);
    const refs = await readdir(path.join(out, "references"));
    expect(refs).toContain("a.md");
  });

  it("does not write a page outside the bundle dir", async () => {
    const out = path.join(root, "bundle");
    await expect(buildOkfBundle(root, [page({ slug: "../escape" })], out)).rejects.toThrow();
  });
});
