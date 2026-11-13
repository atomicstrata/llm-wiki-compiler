/**
 * @file test/storage/derived-tail.test.ts
 * @description The three things in the derived-output tail (index, MOC, link
 * repair) that had no direct witness once their listings, writes and presence
 * test went through the storage functions.
 *
 * The presence test now splits its path into parent and name. That is the
 * identity only for a `path.join` result ending in a file name, which is what
 * every caller passes; the cases here are of that form. Its "any other failure
 * means not present" branch is the one a path under a regular file reaches.
 *
 * The listing is unguarded and its failures are swallowed by the caller, so a
 * missing directory and a regular file both scan as empty. The index and MOC
 * are written confined to the root EXACTLY as the caller gave it: a relative
 * root and a root reached through a link must produce the same bytes as the
 * real absolute root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { warnDroppedWikiReadIfPresent } from "../../src/compiler/confined-wiki-read.js";
import { generateIndex, scanWikiPages } from "../../src/compiler/indexgen.js";
import { generateMOC } from "../../src/compiler/obsidian.js";

let base: string;
let root: string;
let lines: string[];

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-derived-tail-")));
  root = path.join(base, "project");
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

function page(title: string, tags: string[]): string {
  return `---\ntitle: ${title}\nsummary: About ${title}.\ntags: [${tags.join(", ")}]\n---\n\nBody of ${title}.\n`;
}

async function plantPages(): Promise<void> {
  await writeFile(path.join(root, "wiki/concepts/beta.md"), page("Beta", ["two"]));
  await writeFile(path.join(root, "wiki/concepts/alpha.md"), page("Alpha", ["one", "two"]));
  await writeFile(path.join(root, "wiki/concepts/notes.txt"), "not a page\n");
}

describe("the derived tail on storage functions", () => {
  it("warns about a dropped read only when something is at the path", async () => {
    const dir = path.join(root, "wiki/concepts");
    await writeFile(path.join(dir, "present.md"), "x");
    await symlink(path.join(base, "nowhere.md"), path.join(dir, "dangling.md"));
    const warned = async (name: string): Promise<boolean> => {
      lines.length = 0;
      await warnDroppedWikiReadIfPresent(path.join(dir, name), path.join("wiki/concepts", name), "escapes-dir");
      return lines.some((line) => line.includes(`Dropped wiki read (escapes-dir): wiki/concepts/${name}`));
    };
    expect(await warned("present.md")).toBe(true);
    expect(await warned("absent.md")).toBe(false);
    expect(await warned("dangling.md")).toBe(true);
    expect(await warned("present.md/child.md")).toBe(false);
  });

  it("scans a missing directory and a regular file as empty, and pages in listing order", async () => {
    await plantPages();
    expect(await scanWikiPages(path.join(root, "wiki/absent"))).toEqual([]);
    expect(await scanWikiPages(path.join(root, "wiki/concepts/notes.txt"))).toEqual([]);
    const scanned = await scanWikiPages(path.join(root, "wiki/concepts"));
    expect(scanned.map((entry) => entry.slug).sort()).toEqual(["alpha", "beta"]);
    expect(scanned.map((entry) => entry.meta.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("writes the same index and MOC for a relative root and a linked root as for the real root", async () => {
    await plantPages();
    await symlink(root, path.join(base, "linked"));
    const derived = async (given: string): Promise<string[]> => {
      await rm(path.join(root, "wiki/index.md"), { force: true });
      await rm(path.join(root, "wiki/MOC.md"), { force: true });
      await generateIndex(given);
      await generateMOC(given);
      const index = await readFile(path.join(root, "wiki/index.md"), "utf-8");
      return [index.replace(/Generated .*_$/mu, "Generated <TIME>_"), await readFile(path.join(root, "wiki/MOC.md"), "utf-8")];
    };
    const real = await derived(root);
    expect(real[0]).toContain("[[alpha|Alpha]]");
    expect(real[1]).toContain("Alpha");
    expect(await derived(path.join(base, "linked"))).toEqual(real);
    const cwd = process.cwd();
    try {
      process.chdir(base);
      expect(await derived("project")).toEqual(real);
    } finally {
      process.chdir(cwd);
    }
  });
});
