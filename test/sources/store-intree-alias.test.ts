import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSources, getSource, deleteSource } from "../../src/sources/store.js";

async function seedAlias() {
  const root = await mkdtemp(path.join(tmpdir(), "src-alias-"));
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "sources/real.md"), "---\ntitle: Real\nsource: ident\n---\nbody-real", "utf-8");
  // alias.md -> real.md, sorts BEFORE real.md
  await symlink(path.join(root, "sources/real.md"), path.join(root, "sources/alias.md"));
  return root;
}

describe("in-tree symlink aliases are not sources", () => {
  it("listSources returns only the regular file", async () => {
    const root = await seedAlias();
    const { sources } = await listSources(root);
    expect(sources.map((s) => s.id)).toEqual(["real.md"]); // alias.md excluded
  });
  it("getSource(alias) is null; getSource(real) works", async () => {
    const root = await seedAlias();
    expect(await getSource(root, "alias.md")).toBeNull();
    expect((await getSource(root, "real.md"))?.body).toContain("body-real");
  });
  it("deleteSource(alias) is false; deleteSource(real) is true", async () => {
    const root = await seedAlias();
    expect(await deleteSource(root, "alias.md")).toBe(false);
    expect(await deleteSource(root, "real.md")).toBe(true);
  });
});
