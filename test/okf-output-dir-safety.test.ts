import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, symlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildOkfBundle } from "../src/export/okf/bundle.js";
import { makeExportPage } from "./fixtures/okf-export-page.js";
import { useOkfTempDir } from "./fixtures/okf-temp-dir.js";

const { make } = useOkfTempDir();
const concept = (slug: string) => makeExportPage(slug);

describe("output-dir safety", () => {
  it("refuses a non-empty, non-bundle out dir (no clobber)", async () => {
    const dir = await make("okf-safe-");
    const out = path.join(dir, "notes"); await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "keep.md"), "KEEP");
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/not an OKF bundle/i);
    expect((await stat(path.join(out, "keep.md"))).isFile()).toBe(true);
  });
  it("tolerates a stray .DS_Store: a dir holding only OS noise still exports", async () => {
    const dir = await make("okf-safe-noise-");
    const out = path.join(dir, "fresh"); await mkdir(out, { recursive: true });
    await writeFile(path.join(out, ".DS_Store"), "noise");
    await buildOkfBundle(dir, [concept("a")], out);
    expect((await stat(path.join(out, "index.md"))).isFile()).toBe(true);
  });
  it("refuses an out dir containing a top-level .git", async () => {
    const dir = await make("okf-safe2-");
    const out = path.join(dir, "repo"); await mkdir(path.join(out, ".git"), { recursive: true });
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/\.git/i);
  });
  it("refuses out === project root", async () => {
    const dir = await make("okf-safe-root-");
    await expect(buildOkfBundle(dir, [concept("a")], dir)).rejects.toThrow(/project root/i);
  });
  it("refuses out inside .git (no mkdir under .git)", async () => {
    const dir = await make("okf-safe-ingit-");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const out = path.join(dir, ".git", "okf");
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/\.git/i);
    expect(await stat(out).then(() => true, () => false)).toBe(false); // never created
  });
  it("refuses a fresh out path whose existing parent symlinks INTO .git (resolved; no mkdir)", async () => {
    const dir = await make("okf-safe-symgit-");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await symlink(path.join(dir, ".git"), path.join(dir, "exports")); // <root>/exports -> <root>/.git
    const out = path.join(dir, "exports", "okf");                     // lexically not in .git; RESOLVES into .git
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/\.git/i);
    expect(await stat(path.join(dir, ".git", "okf")).then(() => true, () => false)).toBe(false); // never created
  });
  it("refuses to wholesale-clear a recognized bundle that contains a nested .git", async () => {
    const dir = await make("okf-safe-nested-");
    const out = path.join(dir, "bundle");
    await buildOkfBundle(dir, [concept("a")], out);                 // make it a recognized bundle
    await mkdir(path.join(out, "sub", ".git"), { recursive: true }); // plant a nested repo
    await expect(buildOkfBundle(dir, [concept("a")], out)).rejects.toThrow(/nested \.git/i);
  });
  it("a symlinked subdir in the bundle does not redirect a nested write", async () => {
    const dir = await make("okf-safe-symlink-");
    const out = path.join(dir, "bundle");
    await buildOkfBundle(dir, [concept("a")], out);                 // recognized bundle
    const outside = await mkdtemp(path.join(tmpdir(), "okf-safe-out-"));
    await symlink(outside, path.join(out, "tables"));               // tables -> outside
    const foreign = makeExportPage("tables-customers", { okfPath: "tables/customers.md" });
    // wholesale-clear removes the symlink, so the write lands in a fresh real dir, not `outside`:
    await buildOkfBundle(dir, [foreign], out);
    expect(await stat(path.join(outside, "customers.md")).then(() => true, () => false)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
  it("wholesale-clears a recognized prior bundle (stale gone)", async () => {
    const dir = await make("okf-safe3-");
    const out = path.join(dir, "bundle");
    await buildOkfBundle(dir, [concept("a"), concept("old")], out); // first export → bundle with two docs
    await buildOkfBundle(dir, [concept("a")], out);                 // re-export without "old"
    expect(await stat(path.join(out, "concepts/old.md")).then(() => true, () => false)).toBe(false);
  });
});
