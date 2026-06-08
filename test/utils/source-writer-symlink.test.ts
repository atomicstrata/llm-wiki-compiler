import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSource } from "../../src/utils/source-writer.js";

describe("saveSource ignores symlinked source entries (no read/write-through)", () => {
  it("does not match or write through a symlink escaping sources/", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sw-symlink-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    // an OUTSIDE file whose frontmatter source matches what we'll ingest
    const outside = path.join(root, "outside.md");
    const outsideContent = "---\ntitle: Outside\nsource: poison\n---\nORIGINAL OUTSIDE CONTENT";
    await writeFile(outside, outsideContent, "utf-8");
    // plant a symlink inside sources/ pointing at the outside file
    await symlink(outside, path.join(root, "sources/evil.md"));

    // ingest a NEW source with identity "poison" — must NOT match evil.md (the symlink),
    // must NOT write through it, and must create a fresh real source file.
    const doc = "---\ntitle: Safe\nsource: poison\ningestedAt: 2026-01-01T00:00:00.000Z\n---\n\nsafe body";
    const r = await saveSource(root, "Safe", doc, "poison");

    expect(r.writeStatus).toBe("created"); // not "updated" via the symlink
    expect(path.basename(r.path)).not.toBe("evil.md"); // wrote a real file, not the symlink
    // the outside file is UNTOUCHED (no write-through):
    expect(await readFile(outside, "utf-8")).toBe(outsideContent);
    // a real (non-symlink) source file now exists
    const names = (await readdir(path.join(root, "sources"))).filter((f) => f.endsWith(".md"));
    expect(names).toContain(path.basename(r.path));
  });
});
