import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";

describe("createWiki facade (non-LLM)", () => {
  it("ingests, lists seeded pages, exports — silently — under a normalized root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-sdk-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/a.md"), "---\ntitle: A\nsummary: s\n---\nbody", "utf-8");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wiki = createWiki({ root });
    await wiki.ingestText({ title: "Note", text: "hello" });
    const { pages } = await wiki.listPages();
    const doc = await wiki.exportJson();
    expect((await readdir(path.join(root, "sources"))).length).toBe(1);
    expect(pages.map((p) => p.slug)).toContain("a");
    expect(doc.schemaVersion).toBe(1);
    expect(logSpy).not.toHaveBeenCalled(); // quiet by default
    expect(warnSpy).not.toHaveBeenCalled(); // note() routes to console.warn
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
