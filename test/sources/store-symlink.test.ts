import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSources, getSource, deleteSource } from "../../src/sources/store.js";

describe("source store rejects symlink escape", () => {
  it("does not read or list a symlink pointing outside sources/", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-symlink-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    // a real source, and a SECRET file outside sources/
    await writeFile(path.join(root, "sources/real.md"), "---\ntitle: Real\nsource: s\n---\nreal-body", "utf-8");
    await writeFile(path.join(root, "secret.txt"), "TOP SECRET CONTENTS", "utf-8");
    // plant a symlink inside sources/ that escapes to the secret
    await symlink(path.join(root, "secret.txt"), path.join(root, "sources/leak.md"));

    const { sources } = await listSources(root, { includeBody: true });
    expect(sources.map((s) => s.id)).toEqual(["real.md"]); // leak.md excluded
    expect(JSON.stringify(sources)).not.toContain("SECRET");

    expect(await getSource(root, "leak.md")).toBeNull(); // not read through the symlink
    expect((await getSource(root, "real.md"))?.body).toContain("real-body"); // real file still works
  });

  it("deleteSource agrees with getSource on an escaping symlink (both treat it as absent)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "src-del-sym-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    await writeFile(path.join(root, "secret.txt"), "SECRET", "utf-8");
    await symlink(path.join(root, "secret.txt"), path.join(root, "sources/leak.md"));
    await writeFile(path.join(root, "sources/real.md"), "---\ntitle: R\nsource: s\n---\nbody", "utf-8");

    expect(await getSource(root, "leak.md")).toBeNull();       // get: not a source
    expect(await deleteSource(root, "leak.md")).toBe(false);   // delete: also not a source (coherent)
    expect(await deleteSource(root, "real.md")).toBe(true);    // real file deletes
    expect(await deleteSource(root, "missing.md")).toBe(false); // absent → false
  });
});
