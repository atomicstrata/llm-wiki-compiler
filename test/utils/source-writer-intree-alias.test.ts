import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSource } from "../../src/utils/source-writer.js";

describe("saveSource re-ingest is not blocked by an in-tree symlink alias", () => {
  it("updates the real file even when an alias sorts first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sw-alias-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    await writeFile(path.join(root, "sources/real.md"),
      "---\ntitle: Real\nsource: ident\ningestedAt: 2026-01-01T00:00:00.000Z\n---\n\nold body", "utf-8");
    await symlink(path.join(root, "sources/real.md"), path.join(root, "sources/alias.md")); // sorts first

    const doc = "---\ntitle: Real\nsource: ident\ningestedAt: 2026-02-02T00:00:00.000Z\n---\n\nnew body";
    const r = await saveSource(root, "Real", doc, "ident"); // must NOT throw

    expect(r.writeStatus).toBe("updated");
    expect(path.basename(r.path)).toBe("real.md"); // updated the regular file, not the alias
  });
});
