/**
 * @file test/storage/okf-bundle-io.test.ts
 * @description FIXED outcomes for the filesystem behaviour of the OKF import
 * reader, the import collision check and the OKF export bundle writer, now
 * that their calls go through `src/storage/`.
 *
 * What is pinned is the ORDER and the ABSENCE of calls, which is where these
 * functions keep their safety: a document is sized before it is read and an
 * oversize one is never read; the live-page check asks about concepts before
 * queries and stops at the first hit; an export refuses a dangerous target
 * before it makes any directory; and nothing is removed unless the output is
 * a recognized bundle with no nested repository. In particular an output
 * directory whose `index.md` is only a LINK to a real bundle index is not a
 * bundle: it is refused, untouched, with no removal attempted.
 *
 * Every watched `fs/promises` call is recorded by a module mock that forwards
 * to the real filesystem. Arrangement and result checks use the synchronous
 * `node:fs` API, which is not watched.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "bun:test";

/** Every watched call, as `<function> <path relative to the test's base>`, and the names watched. */
const calls = {
  log: [] as string[],
  base: "",
  watched: ["readdir", "stat", "readFile", "access", "lstat", "mkdir", "copyFile", "rm"],
};

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("fs/promises")) };

// Synchronous on purpose: Bun runs the factory eagerly, and an `await` inside it
// never resumes, hanging the file at load.
vi.mock("fs/promises", () => {
  const disk = realFsPromises as unknown as Record<string, (...args: unknown[]) => unknown>;
  const watched = Object.fromEntries(calls.watched.map((name) => [name, (target: unknown, ...rest: unknown[]) => {
    calls.log.push(`${name} ${path.relative(calls.base, String(target)) || "."}`);
    return disk[name]!(target, ...rest);
  }]));
  return { ...disk, ...watched };
});

import { buildOkfBundle } from "../../src/export/okf/bundle.js";
import { filterCollisions } from "../../src/import/okf-collision.js";
import { DEFAULT_OKF_LIMITS } from "../../src/import/okf-limits.js";
import { readIndexFrontmatter, readOkfBundle } from "../../src/import/okf-read.js";
import type { MappedOkfPage } from "../../src/import/types.js";
import { makeExportPage } from "../fixtures/okf-export-page.js";

const DOC = "---\ntype: concept\ntitle: A\n---\n\nBody A.\n";
const BUNDLE_INDEX = '---\nokf_version: "0.1"\n---\n# Bundle\n';
const NOT_UTF8 = Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80]);

/** A fresh base directory holding `files`; the call log starts empty and is relative to it. */
function arrange(files: Record<string, string | Buffer>): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "okf-bundle-io-")));
  onTestFinished(() => rmSync(base, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
    writeFileSync(path.join(base, relative), content);
  }
  calls.base = base;
  calls.log = [];
  return base;
}

const made = (name: string): string[] => calls.log.filter((entry) => entry.startsWith(`${name} `));
const mapped = (slug: string): MappedOkfPage => ({ slug, title: slug, summary: "", sources: [], targetDirectory: "concepts", okfPath: `concepts/${slug}.md`, body: "x" });

describe("OKF import reader", () => {
  it("lists each directory once, and sizes a document before reading it", async () => {
    const base = arrange({ "b/index.md": BUNDLE_INDEX, "b/concepts/a.md": DOC, "b/deep/er/c.md": DOC });
    expect((await readOkfBundle(path.join(base, "b"))).map((doc) => doc.relPath)).toEqual(["concepts/a.md", "deep/er/c.md"]);
    // Walk order follows the runtime's raw readdir order (unsorted under Bun); each directory is listed once.
    expect(made("readdir").sort()).toEqual(["readdir b", "readdir b/concepts", "readdir b/deep", "readdir b/deep/er"]);
    expect(calls.log.indexOf("stat b/concepts/a.md")).toBeGreaterThanOrEqual(0);
    expect(calls.log.indexOf("stat b/concepts/a.md")).toBeLessThan(calls.log.indexOf("readFile b/concepts/a.md"));
  });

  it("rejects an oversize document without reading it", async () => {
    const base = arrange({ "b/concepts/a.md": DOC });
    await expect(readOkfBundle(path.join(base, "b"), { maxDocBytes: 10 })).rejects.toThrow(/exceeds size limit at concepts\/a\.md/);
    expect(made("stat")).toEqual(["stat b/concepts/a.md"]);
    expect(made("readFile")).toEqual([]);
  });

  it("warns about an oversize index.md and does not read it", async () => {
    const base = arrange({ "b/index.md": BUNDLE_INDEX });
    const warnings: string[] = [];
    expect(await readIndexFrontmatter(path.join(base, "b"), { ...DEFAULT_OKF_LIMITS, maxDocBytes: 5 }, (message) => warnings.push(message))).toEqual({});
    expect(warnings).toEqual(["OKF import: index.md exceeds size limit; bundle metadata block ignored"]);
    expect(made("readFile")).toEqual([]);
  });
});

describe("OKF import collision check", () => {
  it("asks about concepts before queries, and not about queries after a hit", async () => {
    const base = arrange({ "wiki/concepts/hit.md": "x", "wiki/queries/asked.md": "y" });
    const { kept, skipped } = await filterCollisions(base, [mapped("hit"), mapped("asked"), mapped("fresh")]);
    expect([kept.map((page) => page.slug), skipped.map((page) => `${page.slug}:${page.reason}`)]).toEqual([["fresh"], ["hit:live-page", "asked:live-page"]]);
    expect(made("access")).toEqual([
      "access wiki/concepts/hit.md", "access wiki/concepts/asked.md", "access wiki/queries/asked.md", "access wiki/concepts/fresh.md", "access wiki/queries/fresh.md",
    ]);
  });

  it("counts a directory at the page path as live, and a dangling link as absent", async () => {
    const base = arrange({ "wiki/concepts/dir.md/inner": "x" });
    symlinkSync("no-such-target.md", path.join(base, "wiki/concepts/dangling.md"));
    const { kept, skipped } = await filterCollisions(base, [mapped("dir"), mapped("dangling")]);
    expect([kept.map((page) => page.slug), skipped.map((page) => page.slug)]).toEqual([["dangling"], ["dir"]]);
  });
});

describe("OKF export bundle writer", () => {
  it("refuses a dangerous target before making any directory", async () => {
    const base = arrange({ "wiki/concepts/a.md": "x" });
    await expect(buildOkfBundle(base, [makeExportPage("a")], base)).rejects.toThrow(/project root/);
    expect(made("mkdir")).toEqual([]);
  });

  it("clears a recognized bundle child by child, keeps the directory, and leaves a linked outside directory alone", async () => {
    const base = arrange({ "out/index.md": BUNDLE_INDEX, "out/concepts/old.md": "old", "out/stale.md": "stale", "outside/kept.md": "kept\n" });
    symlinkSync(path.join(base, "outside"), path.join(base, "out/link-out"));
    await buildOkfBundle(base, [makeExportPage("a")], path.join(base, "out"));
    expect(made("rm").sort()).toEqual(["rm out/concepts", "rm out/index.md", "rm out/link-out", "rm out/stale.md"]);
    expect(readFileSync(path.join(base, "outside/kept.md"), "utf8")).toBe("kept\n");
    expect(readdirSync(path.join(base, "out")).sort()).toEqual(["concepts", "index.md", "log.md"]);
  });

  it("stops at a nested .git before removing anything", async () => {
    const base = arrange({ "out/index.md": BUNDLE_INDEX, "out/sub/.git/HEAD": "ref", "out/keep.md": "keep" });
    await expect(buildOkfBundle(base, [makeExportPage("a")], path.join(base, "out"))).rejects.toThrow(/nested \.git/);
    expect(made("rm")).toEqual([]);
    expect(readFileSync(path.join(base, "out/keep.md"), "utf8")).toBe("keep");
  });

  it("refuses a non-empty directory that is not a bundle, untouched", async () => {
    const base = arrange({ "out/notes.md": "mine" });
    await expect(buildOkfBundle(base, [makeExportPage("a")], path.join(base, "out"))).rejects.toThrow(/not an OKF bundle/);
    expect(made("rm")).toEqual([]);
    expect(readdirSync(path.join(base, "out"))).toEqual(["notes.md"]);
  });

  it("does not take a LINK named index.md for a bundle: refused, untouched, nothing removed", async () => {
    const base = arrange({ "elsewhere/index.md": BUNDLE_INDEX, "out/mine.md": "mine" });
    symlinkSync(path.join(base, "elsewhere/index.md"), path.join(base, "out/index.md"));
    await expect(buildOkfBundle(base, [makeExportPage("a")], path.join(base, "out"))).rejects.toThrow(/not an OKF bundle/);
    expect(made("rm")).toEqual([]);
    expect(readdirSync(path.join(base, "out")).sort()).toEqual(["index.md", "mine.md"]);
    expect(readFileSync(path.join(base, "elsewhere/index.md"), "utf8")).toBe(BUNDLE_INDEX);
  });

  it("copies a cited source byte for byte, and writes a synthetic log when the project has none", async () => {
    const base = arrange({ "sources/cited.bin": NOT_UTF8 });
    const page = { ...makeExportPage("a"), citations: [{ file: "cited.bin" }] };
    await buildOkfBundle(base, [page], path.join(base, "out"));
    const copied = readdirSync(path.join(base, "out/references"));
    expect(copied).toHaveLength(1);
    expect(readFileSync(path.join(base, "out/references", copied[0]!)).equals(NOT_UTF8)).toBe(true);
    expect(made("copyFile")).toEqual(["copyFile sources/cited.bin"]);
    expect(made("readFile")).toContain("readFile log.md");
    expect(existsSync(path.join(base, "log.md"))).toBe(false);
    expect(readFileSync(path.join(base, "out/log.md"), "utf8")).toMatch(/Export.*1 doc\(s\)/s);
  });
});
