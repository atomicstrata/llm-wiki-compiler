/**
 * @file test/storage/project-state-reads.test.ts
 * @description The project-state collector behind `llmwiki next`, `quickstart`
 * and the context pack, through its REAL function on real files in a temp
 * project. The file states what moving the collector's five direct disk calls
 * (three `stat`, one `readdir`, one `readFile`) behind `src/storage/` must not
 * change, so it is run byte for byte against the source both before and after
 * that move.
 *
 * Three cases assert outcomes the existing collector tests do not state: that
 * its three `stat` probes FOLLOW links, that its page count takes regular
 * `.md` entries of one directory only, and what a lint cache that is not a
 * file, or cannot be read, reports. A1 is the only argument case. Other
 * modules on this journey also call `stat`, `readdir` and `readFile`, so A1
 * does not assert a whole list: it keeps the calls whose first argument is one
 * of four named paths that only the collector touches, and asserts those in
 * order.
 *
 * One `readFile` on one exact path can be made to reject. While set, the
 * fault rejects EVERY `readFile` of that path, not only the next one; it is
 * cleared before each case. Setup and checks use the real, unwrapped functions.
 */

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "bun:test";

/** `calls` are [function name, ...arguments] noted while `on`; `failRead` is the one path whose `readFile` rejects. */
const io = (() => ({ on: false, calls: [] as unknown[][], failRead: null as string | null }))();

/** A copy of one `fs/promises` module object with `stat`, `readdir` and `readFile` noted, as named exports and on `default`. */
const noting = (() => <T extends object>(actual: T): T => {
  const real = actual as unknown as Record<string, (...args: unknown[]) => unknown>;
  const noted: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of ["stat", "readdir", "readFile"]) {
    noted[name] = (...args: unknown[]): unknown => {
      if (io.on) io.calls.push([name, ...args]);
      if (name === "readFile" && args[0] === io.failRead) return Promise.reject(new Error("injected read failure"));
      return real[name]!(...args);
    };
  }
  return { ...actual, ...noted, default: { ...actual, ...noted } };
})();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("node:fs/promises")) };

// Both spellings: the collector uses the bare module name before the move and storage uses `node:` after it.
vi.mock("fs/promises", async () => noting((realFsPromises as typeof import("fs/promises"))));
vi.mock("node:fs/promises", async () => noting((realFsPromises as typeof import("node:fs/promises"))));

import { writeLintCache } from "../../src/linter/cache.js";
import { collectProjectState } from "../../src/project/state.js";
import { CONCEPTS_DIR, INDEX_FILE, LAST_LINT_FILE, QUERIES_DIR, SOURCES_DIR } from "../../src/utils/constants.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const fs = realFsPromises as typeof import("node:fs/promises");
useTempRoot();

const root = (): string => process.cwd();
const at = (relative: string): string => path.join(root(), relative);

/** Write `text` at a path under the project root, creating its directory. */
async function put(relative: string, text: string): Promise<string> {
  await fs.mkdir(path.dirname(at(relative)), { recursive: true });
  await fs.writeFile(at(relative), text, "utf-8");
  return at(relative);
}

/** Write a lint cache the collector accepts. */
async function validLintCache(): Promise<void> {
  await writeLintCache(root(), { warnings: 2, errors: 0, info: 0, results: [] });
}

beforeEach(() => { Object.assign(io, { on: false, calls: [], failRead: null }); });

describe("the collector's probes follow links", () => {
  it("L1 reads a linked sources directory and a linked index as present, and a dangling index link as missing", async () => {
    const target = path.dirname(await put("elsewhere/a.md", "a source"));
    await fs.symlink(target, at(SOURCES_DIR));
    await fs.symlink(await put("wiki/real-index.md", "# index"), at(INDEX_FILE));
    const linked = await collectProjectState(root());
    expect(linked.hasSourcesDir).toBe(true);
    expect(linked.hasIndex).toBe(true);
    expect(linked.latestSourceMtimeMs).toBe((await fs.stat(target)).mtimeMs);
    await fs.rm(at("wiki/real-index.md"));
    expect((await collectProjectState(root())).hasIndex).toBe(false);
  });
});

describe("the collector's page count", () => {
  it("L2 counts one real page and not a directory named x.md, a link named y.md, or a nested deep/z.md", async () => {
    const page = await put(`${CONCEPTS_DIR}/real.md`, "# real");
    await fs.mkdir(at(`${CONCEPTS_DIR}/x.md`));
    await fs.symlink(page, at(`${CONCEPTS_DIR}/y.md`));
    await put(`${CONCEPTS_DIR}/deep/z.md`, "# nested");
    expect((await collectProjectState(root())).conceptCount).toBe(1);
  });
});

describe("the collector's lint cache status", () => {
  it("L3 reports a directory at the cache path as not present, and a valid cache whose read rejects as present with no entry", async () => {
    await fs.mkdir(at(LAST_LINT_FILE), { recursive: true });
    expect((await collectProjectState(root())).lint).toEqual({ present: false, entry: null });
    await fs.rm(at(LAST_LINT_FILE), { recursive: true });
    await validLintCache();
    expect((await collectProjectState(root())).lint.entry).not.toBeNull();
    io.failRead = at(LAST_LINT_FILE);
    expect((await collectProjectState(root())).lint).toEqual({ present: true, entry: null });
  });
});

describe("the collector's own disk calls, by argument", () => {
  it("A1 makes exactly these six calls, in order, on the wiki directory, the queries directory, the index and the lint cache", async () => {
    await put(INDEX_FILE, "# index");
    await validLintCache();
    const watched = [at("wiki"), at(QUERIES_DIR), at(INDEX_FILE), at(LAST_LINT_FILE)];
    io.on = true;
    try {
      await collectProjectState(root());
    } finally {
      io.on = false;
    }
    expect(io.calls.filter((call) => watched.includes(call[1] as string))).toStrictEqual([
      ["stat", at("wiki")],
      ["readdir", at(QUERIES_DIR), { withFileTypes: true }],
      ["stat", at(INDEX_FILE)],
      ["stat", at(LAST_LINT_FILE)],
      ["readFile", at(LAST_LINT_FILE), "utf-8"],
      ["stat", at("wiki")],
    ]);
  });
});
