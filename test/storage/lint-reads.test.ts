/**
 * @file test/storage/lint-reads.test.ts
 * @description FIXED outcomes for the disk calls lint makes through
 * `src/storage/`: the typed directory listing added for the wiki-wide page
 * walk, both scopes of `collectAllPages`, the lint cache's write and read, and
 * the one page read `lint --fix-propose` makes before it stages a candidate.
 *
 * What is pinned is what a caller can observe, on real files: which pages come
 * back and in what order, which entries are skipped, which failures are
 * swallowed and which reach the caller as the very error the disk raised, the
 * cache's exact bytes, and the order of the calls the cache writer makes.
 *
 * Every call is observed through one module mock of `fs/promises` that
 * forwards to the real filesystem. It can also reverse a listing or fail one
 * chosen call, which is how "order returned, not sorted" and "the raw error"
 * are shown without depending on what order a filesystem happens to list in.
 * The storage files import `node:fs/promises`; the mock reaching them is part
 * of what is shown. The call-order test records WHICH calls are made, in what
 * order; it is not a claim about what a crash leaves on disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi, setSystemTime } from "bun:test";
import * as fs from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface PlannedFault { call: string; nth: number; error: Error }
/** What the mock saw, and what it was asked to disturb. */
const tape = (() => ({
  calls: [] as string[], lastListing: null as unknown,
  reverseListings: false, fault: null as PlannedFault | null,
}))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", async () => {
  const actual = realFsPromises as typeof import("fs/promises");
  type Forwarded = (...args: unknown[]) => Promise<unknown>;
  const watch = (name: string): Forwarded => (...args) => {
    const call = `${name} ${String(args[0])}`;
    tape.calls.push(args[1] === undefined ? call : `${call} ${JSON.stringify(args[1])}`);
    const seen = tape.calls.filter((entry) => entry.startsWith(call)).length;
    if (tape.fault?.call === call && tape.fault.nth === seen) return Promise.reject(tape.fault.error);
    return (actual[name as keyof typeof actual] as Forwarded)(...args);
  };
  const readdir: Forwarded = (...args) => {
    const listed = watch("readdir")(...args) as Promise<unknown[]>;
    tape.lastListing = tape.reverseListings ? listed.then((entries) => [...entries].reverse()) : listed;
    return tape.lastListing as Promise<unknown>;
  };
  const watched = Object.fromEntries(["readFile", "mkdir", "open", "rename"].map((name) => [name, watch(name)]));
  return { ...actual, ...watched, readdir };
});

import { listDirectoryEntries } from "../../src/storage/disk-guarded-leaves.js";
import { collectAllPages } from "../../src/linter/rules-shared.js";
import { readLintCache, writeLintCache } from "../../src/linter/cache.js";
import { lintFixProposeCommand } from "../../src/commands/lint-fix-propose.js";
import { listCandidates } from "../../src/compiler/candidates.js";
import { sha256Text } from "../../src/connectors/hash.js";
import { useCommandProject } from "../fixtures/command-project.js";

const project = useCommandProject("lint-reads-");
/** The project root as the commands see it: the resolved working directory. */
let root = "";

/** Plant `relativePath` under the project, creating its directories. */
async function plant(relativePath: string, text = "body\n"): Promise<string> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
  return target;
}

/** The pages' paths, relative to the project, in the order returned. */
function relativePaths(pages: ReadonlyArray<{ filePath: string }>): string[] {
  return pages.map((page) => path.relative(root, page.filePath));
}

/** The recorded calls of one kind, with the project root cut off. */
function recorded(kind: string): string[] {
  return tape.calls.filter((call) => call.startsWith(`${kind} `)).map((call) => call.split(`${root}/`).join(""));
}

/** An error no filesystem raises, so seeing it again proves it was passed on. */
function plantedError(): Error {
  return Object.assign(new Error("planted disk failure"), { code: "EPLANTED" });
}

beforeEach(() => {
  root = process.cwd();
  expect(path.basename(root)).toBe(path.basename(project.root));
  Object.assign(tape, { calls: [], lastListing: null, reverseListings: false, fault: null });
});

afterEach(() => { setSystemTime(); });

describe("listDirectoryEntries: one typed listing, nothing added", () => {
  it("hands back the listing's own promise, and each entry answers for itself", async () => {
    await plant("dir/page.md");
    await plant("dir/sub/inner.md");
    await fs.symlink(path.join(root, "dir", "page.md"), path.join(root, "dir", "linked.md"));
    const returned = listDirectoryEntries(path.join(root, "dir"));
    expect(returned).toBe(tape.lastListing);
    const kinds = (await returned).map((entry) => `${entry.name}:${entry.isFile()}:${entry.isDirectory()}`);
    expect(kinds.sort()).toEqual(["linked.md:false:false", "page.md:true:false", "sub:false:true"]);
    expect(recorded("readdir")).toEqual(['readdir dir {"withFileTypes":true}']);
  });

  it("rejects with the disk's own error for a missing directory and for a file", async () => {
    const file = await plant("plain.md");
    await expect(listDirectoryEntries(path.join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listDirectoryEntries(file)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("collectAllPages, generic scope: concepts then queries, as listed", () => {
  beforeEach(async () => {
    for (const name of ["a.md", "b.md", "c.md", "notes.txt"]) await plant(`wiki/concepts/${name}`, `concept ${name}\n`);
    for (const name of ["q1.md", "q2.md"]) await plant(`wiki/queries/${name}`, `query ${name}\n`);
    await plant("wiki/concepts/nested/deep.md");
  });

  it("returns markdown leaves only, with their text, concepts before queries", async () => {
    const pages = await collectAllPages(root);
    expect(relativePaths(pages).sort()).toEqual([
      "wiki/concepts/a.md", "wiki/concepts/b.md", "wiki/concepts/c.md", "wiki/queries/q1.md", "wiki/queries/q2.md",
    ]);
    expect(relativePaths(pages).slice(3).sort()).toEqual(["wiki/queries/q1.md", "wiki/queries/q2.md"]);
    expect(pages.find((page) => page.filePath.endsWith("b.md"))?.content).toBe("concept b.md\n");
    expect(recorded("readdir")).toEqual(["readdir wiki/concepts", "readdir wiki/queries"]);
    expect(recorded("readFile")).toHaveLength(5);
    expect(recorded("readFile").every((call) => call.endsWith('"utf-8"'))).toBe(true);
  });

  // Node's readdir arrived name-sorted (libuv sorts); Bun's returns raw directory
  // order. The disk adapter now orders names itself, so output never depends on
  // the runtime or filesystem: a reversed raw listing must change nothing.
  it("orders each directory by name whatever order readdir returned", async () => {
    const asListed = relativePaths(await collectAllPages(root));
    tape.reverseListings = true;
    const reversed = relativePaths(await collectAllPages(root));
    expect(asListed).toEqual([
      "wiki/concepts/a.md", "wiki/concepts/b.md", "wiki/concepts/c.md", "wiki/queries/q1.md", "wiki/queries/q2.md",
    ]);
    expect(reversed).toEqual(asListed);
  });

  it("lists nothing for absent directories, and passes a read failure on untouched", async () => {
    await fs.rm(path.join(root, "wiki"), { recursive: true });
    expect(await collectAllPages(root)).toEqual([]);
    expect(recorded("readdir")).toEqual([]);
    const page = await plant("wiki/queries/only.md");
    const error = plantedError();
    tape.fault = { call: `readFile ${page}`, nth: 1, error };
    await expect(collectAllPages(root)).rejects.toBe(error);
  });

  it("rejects when a directory is named like a page, because it is read as one", async () => {
    await fs.mkdir(path.join(root, "wiki", "queries", "folder.md"));
    await expect(collectAllPages(root)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("collectAllPages, wiki-wide scope: every page under wiki/, sorted", () => {
  const deepest = "wiki/d1/d2/d3/d4/d5";

  beforeEach(async () => {
    for (const page of ["index.md", "concepts/b.md", "concepts/a.md", "people/ada.md", "research/papers/p.md"]) {
      await plant(`wiki/${page}`, `text of ${page}\n`);
    }
    for (const skipped of [".obsidian/workspace.md", "concepts/.hidden.md", "concepts/notes.txt"]) {
      await plant(`wiki/${skipped}`);
    }
  });

  it("returns pages sorted by path whatever order the listings came in", async () => {
    const expected = [
      "wiki/concepts/a.md", "wiki/concepts/b.md", "wiki/index.md", "wiki/people/ada.md", "wiki/research/papers/p.md",
    ];
    const pages = await collectAllPages(root, "wiki-wide");
    expect(relativePaths(pages)).toEqual(expected);
    expect(pages[2]?.content).toBe("text of index.md\n");
    tape.reverseListings = true;
    expect(relativePaths(await collectAllPages(root, "wiki-wide"))).toEqual(expected);
  });

  it("never lists a dot-directory, and skips linked pages and linked directories", async () => {
    await fs.symlink(path.join(root, "wiki", "index.md"), path.join(root, "wiki", "concepts", "linked.md"));
    await fs.symlink(path.join(root, "wiki", "people"), path.join(root, "wiki", "linked-dir"));
    const pages = relativePaths(await collectAllPages(root, "wiki-wide"));
    expect(pages.filter((page) => page.includes("linked"))).toEqual([]);
    expect(pages).toHaveLength(5);
    expect(recorded("readdir").sort()).toEqual([
      "wiki", "wiki/concepts", "wiki/people", "wiki/research", "wiki/research/papers",
    ].map((dir) => `readdir ${dir} {"withFileTypes":true}`));
  });

  it("walks six levels of directories and does not list a seventh", async () => {
    await plant(`${deepest}/in.md`);
    await plant(`${deepest}/d6/out.md`);
    const pages = relativePaths(await collectAllPages(root, "wiki-wide"));
    expect(pages).toContain(`${deepest}/in.md`);
    expect(pages).not.toContain(`${deepest}/d6/out.md`);
    expect(recorded("readdir").some((call) => call.includes(`${deepest}/d6`))).toBe(false);
  });

  it("swallows one directory's listing failure and still returns the other pages", async () => {
    tape.fault = { call: `readdir ${path.join(root, "wiki", "people")}`, nth: 1, error: plantedError() };
    const pages = relativePaths(await collectAllPages(root, "wiki-wide"));
    expect(pages).toEqual(["wiki/concepts/a.md", "wiki/concepts/b.md", "wiki/index.md", "wiki/research/papers/p.md"]);
  });

  it("passes a page read failure on untouched, and lists nothing without wiki/", async () => {
    const error = plantedError();
    tape.fault = { call: `readFile ${path.join(root, "wiki", "people", "ada.md")}`, nth: 1, error };
    await expect(collectAllPages(root, "wiki-wide")).rejects.toBe(error);
    await fs.rm(path.join(root, "wiki"), { recursive: true });
    tape.calls = [];
    expect(await collectAllPages(root, "wiki-wide")).toEqual([]);
    expect(recorded("readdir")).toEqual([]);
  });
});

describe("the lint cache: exact bytes out, strict read back", () => {
  const CACHE = ".llmwiki/last-lint.json";
  const finding = (file: string) => ({ rule: "broken-wikilink", severity: "error" as const, file, message: "m" });
  const summary = () => ({
    errors: 2, warnings: 0, info: 0,
    results: [finding(path.join(root, "wiki/concepts/a.md")), finding(path.join(root, "wiki/concepts/a.md"))],
  });

  it("writes the same bytes at a fixed clock, through the writer's own calls in order", async () => {
    setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
    await writeLintCache(root, summary());
    const rule = { rule: "broken-wikilink", severity: "error", count: 2, fileCount: 1, topFile: "wiki/concepts/a.md", topFileCount: 2 };
    const expected = { warnings: 0, errors: 2, at: "2026-01-02T03:04:05.678Z", freshness: { stalePages: 0, orphanedPages: 0 }, rules: [rule] };
    expect(await fs.readFile(path.join(root, CACHE), "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    const written = tape.calls.slice(0, tape.calls.findIndex((call) => call.startsWith("rename ")) + 1);
    const steps = written.map((call) => call.split(" ")[0]);
    expect(steps).toEqual(["mkdir", "mkdir", "open", "rename"]);
    expect(recorded("mkdir")).toEqual(['mkdir .llmwiki {"recursive":true}', 'mkdir .llmwiki {"recursive":true}']);
    expect(recorded("rename")[0]).toMatch(/^rename \.llmwiki\/last-lint\.json\.\S+ "\.llmwiki\/last-lint\.json"$/);
  });

  it("reads back what it wrote with one whole-file read", async () => {
    await writeLintCache(root, summary());
    tape.calls = [];
    const entry = await readLintCache(root);
    expect(entry).toMatchObject({ errors: 2, warnings: 0, freshness: { stalePages: 0, orphanedPages: 0 } });
    expect(entry?.rules).toHaveLength(1);
    expect(recorded("readFile")).toEqual([`readFile ${CACHE} "utf-8"`]);
  });

  it("answers null for a missing cache, a directory in its place, and malformed text", async () => {
    expect(await readLintCache(root)).toBeNull();
    await fs.mkdir(path.join(root, CACHE), { recursive: true });
    expect(await readLintCache(root)).toBeNull();
    await fs.rm(path.join(root, CACHE), { recursive: true });
    await plant(CACHE, "{ not json");
    expect(await readLintCache(root)).toBeNull();
  });
});

describe("lint --fix-propose: the page as it is now is what the candidate carries", () => {
  const LINKER = "wiki/concepts/linker.md";
  const linkerText = '---\ntitle: "Linker"\nsummary: "Links out."\n---\nSee [[Renamed Page]].\n';

  beforeEach(async () => {
    await plant("wiki/concepts/renamed-file.md", '---\ntitle: "Renamed Page"\n---\nBody.\n');
    await plant(LINKER, linkerText);
  });

  it("stages the edited text and the hash of the bytes it read", async () => {
    expect(await lintFixProposeCommand(1)).toBe(0);
    const [candidate] = await listCandidates(root);
    expect(candidate?.expectedTargetHash).toBe(sha256Text(linkerText));
    expect(candidate?.body).toBe(linkerText.replace("[[Renamed Page]]", "[[renamed-file|Renamed Page]]"));
    expect(candidate?.summary).toBe("Links out.");
    expect(await fs.readFile(path.join(root, LINKER), "utf8")).toBe(linkerText);
  });

  it("rejects with the read's own error, stages nothing and releases the lock", async () => {
    const error = plantedError();
    tape.fault = { call: `readFile ${path.join(root, LINKER)}`, nth: 2, error };
    await expect(lintFixProposeCommand(1)).rejects.toBe(error);
    expect(await listCandidates(root)).toEqual([]);
    await expect(fs.access(path.join(root, ".llmwiki", "lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
