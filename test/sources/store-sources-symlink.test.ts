/**
 * Bug 1: sources/ itself being a symlink to an outside directory.
 *
 * Before the fix, safeRealpath(join(root, "sources")) would follow the sources/
 * symlink and return the outside dir as the "trusted base". Every subsequent
 * per-entry confinement check would pass because all entries resolved inside
 * that outside dir. This exposed the outside directory for reads (listSources,
 * getSource) and writes (saveSource).
 *
 * The fix: resolveSourcesDir() requires sources/ to be a REAL directory via
 * lstat() before trusting it. A symlink returns null → treated as absent.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSources, getSource } from "../../src/sources/store.js";
import { saveSource } from "../../src/utils/source-writer.js";

describe("sources/ itself being a symlink is rejected (no escape)", () => {
  async function setup() {
    const base = await mkdtemp(path.join(tmpdir(), "src-symdir-"));
    const root = path.join(base, "proj");
    await mkdir(root, { recursive: true });
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.md"), "---\ntitle: S\nsource: s\n---\nSECRET", "utf-8");
    // <root>/sources is a SYMLINK to the outside dir
    await symlink(outside, path.join(root, "sources"));
    return { root, outside };
  }

  it("listSources/getSource do not expose the outside dir", async () => {
    const { root } = await setup();
    expect((await listSources(root, { includeBody: true })).sources).toEqual([]);
    expect(await getSource(root, "secret.md")).toBeNull();
  });

  it("saveSource does not write into the symlinked-away sources/", async () => {
    const { root, outside } = await setup();
    await expect(saveSource(root, "Note", "---\ntitle: Note\nsource: x\n---\n\nbody\n", "x")).rejects.toThrow();
    const outsideFiles = (await readdir(outside)).sort();
    expect(outsideFiles).toEqual(["secret.md"]); // nothing new written outside
  });
});
