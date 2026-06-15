import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, symlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import type { ExportPage } from "../src/export/types.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const concept = (slug: string): ExportPage =>
  ({ slug, pageDirectory: "concepts", title: slug, summary: "", sources: [], tags: [], createdAt: "", updatedAt: "",
     links: [], body: "b\n", citations: [], freshnessStatus: "unverified", contradicted: false, archived: false,
     contentHash: "", sourceHashes: [], path: "" } as ExportPage);

describe("output-dir safety", () => {
  it("refuses a non-empty, non-bundle out dir (no clobber)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe-"));
    const out = path.join(dir, "notes"); await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "keep.md"), "KEEP");
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/not an OKF bundle/i);
    expect((await stat(path.join(out, "keep.md"))).isFile()).toBe(true);
  });
  it("refuses an out dir containing a top-level .git", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe2-"));
    const out = path.join(dir, "repo"); await mkdir(path.join(out, ".git"), { recursive: true });
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/\.git/i);
  });
  it("refuses out === project root", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe-root-"));
    await expect(buildOkfBundle(dir, [concept("a")], dir)).rejects.toThrow(/project root/i);
  });
  it("refuses out inside .git (no mkdir under .git)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe-ingit-"));
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const out = path.join(dir, ".git", "okf");
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/\.git/i);
    expect(await stat(out).then(() => true, () => false)).toBe(false); // never created
  });
  it("refuses a fresh out path whose existing parent symlinks INTO .git (resolved; no mkdir)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe-symgit-"));
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await symlink(path.join(dir, ".git"), path.join(dir, "exports")); // <root>/exports -> <root>/.git
    const out = path.join(dir, "exports", "okf");                     // lexically not in .git; RESOLVES into .git
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/\.git/i);
    expect(await stat(path.join(dir, ".git", "okf")).then(() => true, () => false)).toBe(false); // never created
  });
  it("refuses to wholesale-clear a recognized bundle that contains a nested .git", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe-nested-"));
    const out = path.join(dir, "bundle");
    await buildOkfBundle(dir, [concept("a")], out);                 // make it a recognized bundle
    await mkdir(path.join(out, "sub", ".git"), { recursive: true }); // plant a nested repo
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/nested \.git/i);
  });
  it("a symlinked subdir in the bundle does not redirect a nested write", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe-symlink-"));
    const out = path.join(dir, "bundle");
    await buildOkfBundle(dir, [concept("a")], out);                 // recognized bundle
    const outside = await mkdtemp(path.join(tmpdir(), "okf-safe-out-"));
    await symlink(outside, path.join(out, "tables"));               // tables -> outside
    const foreign = { ...concept("tables-customers"), xOkf: { okfPath: "tables/customers.md", originalFrontmatter: {} } } as ExportPage;
    // wholesale-clear removes the symlink, so the write lands in a fresh real dir, not `outside`:
    await buildOkfBundle(dir, [foreign], out);
    expect(await stat(path.join(outside, "customers.md")).then(() => true, () => false)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
  it("wholesale-clears a recognized prior bundle (stale gone)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-safe3-"));
    const out = path.join(dir, "bundle");
    await buildOkfBundle(dir, [concept("a"), concept("old")], out); // first export → bundle with two docs
    await buildOkfBundle(dir, [concept("a")], out);                 // re-export without "old"
    expect(await stat(path.join(out, "concepts/old.md")).then(() => true, () => false)).toBe(false);
  });
});
