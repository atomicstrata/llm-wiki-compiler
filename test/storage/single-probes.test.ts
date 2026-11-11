/**
 * @file test/storage/single-probes.test.ts
 * @description Two one-call disk probes through their REAL functions, on real
 * files in a temp project: the `sources` existence check that `llmwiki watch`
 * makes before it starts watching, and the "is the page really gone?" check
 * that `llmwiki rm` makes after each unlink.
 *
 * The file states behaviour that moving those two calls behind `src/storage/`
 * must not change, so it is run byte for byte against the source both before
 * and after that move. Six cases assert outcomes; only A1 asserts a call list.
 *
 * `chokidar` is replaced by a fake watcher that never emits and schedules
 * nothing, and the compiler module by a recording stand-in, so no compile and
 * no provider can be reached. A started `watch` never returns: its promise is
 * kept with a rejection handler and never awaited, and every assertion on it
 * is made straight after the call.
 *
 * W3's last step records INCUMBENT behaviour, kept on purpose and not
 * endorsed: there is no type check, so a regular file named `sources` starts
 * the watcher.
 */

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "bun:test";

/** `calls` are [function name, ...arguments], noted only while `on` is true. */
const io = { on: false, calls: [] as unknown[][] };
/** What the stand-ins saw: watchers created, and compiles requested. */
const seen = { watchers: [] as unknown[][], compiles: [] as unknown[][] };

/** A copy of one `fs` module object whose `name` function notes its calls, as a named export and on `default`. */
const noting = <T extends object>(actual: T, name: "existsSync" | "lstat"): T => {
  const real = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
  const noted = (...args: unknown[]): unknown => {
    if (io.on) io.calls.push([name, ...args]);
    return real(...args);
  };
  return { ...actual, [name]: noted, default: { ...actual, [name]: noted } };
};

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("node:fs/promises")) };
const realFs = { ...(await import("fs")) };

// Both spellings of each module: the two functions under test use the bare names before the move and storage uses `node:` after it.
vi.mock("fs", () => noting(realFs, "existsSync"));
vi.mock("node:fs", () => noting(realFs, "existsSync"));
vi.mock("fs/promises", () => noting(realFsPromises, "lstat"));
vi.mock("node:fs/promises", () => noting(realFsPromises, "lstat"));

vi.mock("chokidar", () => {
  const watcher = { on: (): unknown => watcher };
  return { watch: (...args: unknown[]): unknown => { seen.watchers.push(args); return watcher; } };
});
vi.mock("../../src/compiler/index.js", () => ({
  compile: (...args: unknown[]): Promise<void> => { seen.compiles.push(args); return Promise.resolve(); },
}));

import watchCommand from "../../src/commands/watch.js";
import { confinedUnlink } from "../../src/trust/journal.js";
import { CONCEPTS_DIR, LLMWIKI_DIR, SOURCES_DIR } from "../../src/utils/constants.js";
import * as output from "../../src/utils/output.js";
import { deleteWikiPagesLocked } from "../../src/wiki/delete-page.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const fs = realFsPromises;
const WATCH_OPTIONS = { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200 } };
const STILL_THERE = 'failed to delete wiki page "alpha": file still exists after unlink';
useTempRoot();
let statuses: string[] = [];

const root = (): string => process.cwd();
const sources = (): string => path.resolve(SOURCES_DIR);
const page = (): string => path.join(root(), CONCEPTS_DIR, "alpha.md");
const warnedNoSources = (): boolean => statuses.some((line) => line.startsWith("!") && line.includes("No sources/ directory found"));

/** Start a watch that will not return; give back whatever it rejects with, checked after one microtask turn. */
async function startWatch(): Promise<unknown[]> {
  const rejections: unknown[] = [];
  void watchCommand().catch((error: unknown) => { rejections.push(error); });
  await Promise.resolve();
  return rejections;
}

/** Write the one concept page the delete cases remove. */
async function writePage(): Promise<void> {
  await fs.writeFile(page(), "---\ntitle: alpha\n---\nalpha body", "utf-8");
}

beforeEach(() => {
  Object.assign(io, { on: false, calls: [] });
  Object.assign(seen, { watchers: [], compiles: [] });
  statuses = [];
  vi.spyOn(output, "status").mockImplementation((icon: string, message: string) => { statuses.push(`${icon} ${message}`); });
  vi.spyOn(output, "header").mockImplementation(() => {});
});

describe("watch: the sources check before watching", () => {
  it("W1 warns and returns without creating a watcher when sources is missing", async () => {
    await watchCommand();
    expect(warnedNoSources()).toBe(true);
    expect(seen.watchers).toEqual([]);
    expect(seen.compiles).toEqual([]);
  });

  it("W2 creates one watcher on the resolved sources directory with the same options", async () => {
    await fs.mkdir(sources());
    expect(await startWatch()).toEqual([]);
    expect(seen.watchers).toEqual([[sources(), WATCH_OPTIONS]]);
    expect(warnedNoSources()).toBe(false);
    expect(seen.compiles).toEqual([]);
  });

  it("W3 follows a link to a directory, warns for a dangling link, and starts for a regular file (incumbent, kept)", async () => {
    await fs.mkdir(path.join(root(), "elsewhere"));
    await fs.symlink(path.join(root(), "elsewhere"), sources());
    expect(await startWatch()).toEqual([]);
    expect(seen.watchers).toHaveLength(1);
    await fs.rm(path.join(root(), "elsewhere"), { recursive: true });
    await watchCommand();
    expect(warnedNoSources()).toBe(true);
    expect(seen.watchers).toHaveLength(1);
    await fs.rm(sources());
    await fs.writeFile(sources(), "a file, not a directory", "utf-8");
    expect(await startWatch()).toEqual([]);
    expect(seen.watchers).toHaveLength(2);
    expect(seen.compiles).toEqual([]);
  });
});

describe("rm: the check that a page is gone after its unlink", () => {
  it("D1 rejects with the still-exists message when the page survives, leaving one pending journal file", async () => {
    await writePage();
    const survived = deleteWikiPagesLocked(root(), ["alpha"], { unlinkOne: async () => {} });
    await expect(survived).rejects.toMatchObject({ message: STILL_THERE });
    expect(await fs.readdir(path.join(root(), LLMWIKI_DIR, "journal"))).toHaveLength(1);
  });

  it("D2 counts a dangling link left at the page path as still present", async () => {
    await writePage();
    const leaveLink = async (target: string): Promise<void> => {
      await fs.unlink(target);
      await fs.symlink(path.join(root(), "nowhere.md"), target);
    };
    await expect(deleteWikiPagesLocked(root(), ["alpha"], { unlinkOne: leaveLink })).rejects.toMatchObject({ message: STILL_THERE });
  });

  it("D3 rethrows the raw error when the page path cannot be looked up", async () => {
    await writePage();
    const concepts = path.join(root(), CONCEPTS_DIR);
    const replaceDirectoryWithFile = async (): Promise<void> => {
      await fs.rm(concepts, { recursive: true });
      await fs.writeFile(concepts, "a file where the directory was", "utf-8");
    };
    const failed = await deleteWikiPagesLocked(root(), ["alpha"], { unlinkOne: replaceDirectoryWithFile }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "ENOTDIR", path: page() });
    expect((failed as Error).message).not.toContain("still exists");
  });
});

describe("the two probes, by argument", () => {
  it("A1 makes one existsSync on the resolved sources path and one lstat on the page path", async () => {
    io.on = true;
    try { await watchCommand(); } finally { io.on = false; }
    expect(io.calls).toStrictEqual([["existsSync", sources()]]);
    io.calls = [];
    await writePage();
    const unlinkThenRecord = async (target: string): Promise<void> => {
      await confinedUnlink(target, root());
      io.on = true;
    };
    try {
      await deleteWikiPagesLocked(root(), ["alpha"], { unlinkOne: unlinkThenRecord });
    } finally {
      io.on = false;
    }
    expect(io.calls).toStrictEqual([["lstat", page()]]);
    await expect(fs.lstat(page())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
