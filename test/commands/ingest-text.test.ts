import { describe, it, expect } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestTextSource } from "../../src/commands/ingest.js";

describe("ingestTextSource identity", () => {
  it("is idempotent for same title+text, coexists for same title+different text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-text-"));
    await ingestTextSource(root, { title: "Note", text: "alpha" });
    await ingestTextSource(root, { title: "Note", text: "alpha" }); // same → idempotent
    let files = await readdir(path.join(root, "sources"));
    expect(files.length).toBe(1);
    await ingestTextSource(root, { title: "Note", text: "beta" });  // diff → coexist
    files = await readdir(path.join(root, "sources"));
    expect(files.length).toBe(2);
  });
});
