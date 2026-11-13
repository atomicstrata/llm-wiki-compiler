/**
 * @file test/storage/source-store-leaves.test.ts
 * @description FIXED outcomes for the four filesystem calls the source store
 * (`src/sources/store.ts`) makes through `src/storage/`: the two whole-text
 * reads behind `listSources` and `getSource`, the unlink behind
 * `deleteSource`, and the no-follow lookup behind `sourceFileMissing`.
 *
 * What is pinned is what a caller observes, and the distinctions `llmwiki rm`
 * depends on: a failed read REJECTS out of `listSources` but only `ENOENT`
 * becomes `null` in `getSource`; `deleteSource` unlinks the joined literal
 * path, answers `false` for `ENOENT` alone and rethrows anything else;
 * `sourceFileMissing` is `true` only when nothing is there, so a file, a
 * directory, a link and a DANGLING link are all present. Where an error is
 * rethrown, it is the very same object.
 *
 * Entries are real files, directories and links. Faults that cannot be made
 * on disk are planted through a module mock of `fs/promises` that forwards to
 * the real filesystem and can fail one chosen call on one chosen path. The
 * storage files import `node:fs/promises`; the mock reaching them is part of
 * what is shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as real from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Faulted = "readFile" | "unlink" | "lstat";
/** The one call made to fail, and every unlink the store issued. */
const watch = { fail: null as null | { call: string; target: string; error: Error }, unlinked: [] as string[] };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", () => {
  const disk = realFsPromises;
  const forward = (call: Faulted) => (target: unknown, ...rest: unknown[]): unknown => {
    if (call === "unlink") watch.unlinked.push(String(target));
    if (watch.fail?.call === call && watch.fail.target === target) return Promise.reject(watch.fail.error);
    return (disk[call] as (...args: unknown[]) => unknown)(target, ...rest);
  };
  return { ...disk, readFile: forward("readFile"), unlink: forward("unlink"), lstat: forward("lstat") };
});

import { deleteSource, getSource, listSources, sourceFileMissing } from "../../src/sources/store.js";

const ACCENTED = "Zoë's café — naïve ✓\n";
let root = "";

const source = (id: string): string => path.join(root, "sources", id);
const note = (title: string, body = "body"): string => `---\ntitle: ${title}\nsource: ${title}\n---\n${body}`;

/** Make `call` on `target` reject with a coded error, and return that error. */
function plant(call: Faulted, target: string, code: string): Error {
  const error = Object.assign(new Error(`planted ${call} failure`), { code });
  watch.fail = { call, target, error };
  return error;
}

beforeEach(async () => {
  root = await real.realpath(await real.mkdtemp(path.join(tmpdir(), "source-store-leaves-")));
  await real.mkdir(path.join(root, "sources"));
  await real.writeFile(source("a.md"), note("Alpha", ACCENTED));
  await real.writeFile(source("b.md"), note("Beta"));
  watch.fail = null;
  watch.unlinked = [];
});

afterEach(async () => {
  watch.fail = null;
  await real.rm(root, { recursive: true, force: true });
});

describe("listSources and getSource reads", () => {
  it("lists records in scan order with non-ASCII text intact", async () => {
    const { sources } = await listSources(root, { includeBody: true });
    expect(sources.map((record) => record.id)).toEqual(["a.md", "b.md"]);
    expect(sources[0]).toMatchObject({ title: "Alpha", source: "Alpha", body: ACCENTED });
  });

  it("listSources rejects with the read's own error", async () => {
    const error = plant("readFile", source("b.md"), "EIO");
    await expect(listSources(root)).rejects.toBe(error);
  });

  it("getSource answers null when the read finds nothing after the file was checked", async () => {
    plant("readFile", source("a.md"), "ENOENT");
    expect(await getSource(root, "a.md")).toBeNull();
    watch.fail = null;
    expect(await getSource(root, "a.md")).toMatchObject({ id: "a.md", body: ACCENTED });
  });

  it("getSource rejects with any other read error, unchanged", async () => {
    const error = plant("readFile", source("a.md"), "EACCES");
    await expect(getSource(root, "a.md")).rejects.toBe(error);
  });
});

describe("deleteSource unlink", () => {
  it("unlinks the joined literal path and answers true", async () => {
    expect(await deleteSource(root, "a.md")).toBe(true);
    expect(watch.unlinked).toEqual([source("a.md")]);
    await expect(real.lstat(source("a.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await deleteSource(root, "a.md")).toBe(false);
    expect(watch.unlinked).toHaveLength(1);
  });

  it("answers false when the unlink finds nothing", async () => {
    plant("unlink", source("a.md"), "ENOENT");
    expect(await deleteSource(root, "a.md")).toBe(false);
    expect(watch.unlinked).toEqual([source("a.md")]);
  });

  it("rejects with any other unlink error, unchanged, and the file stays", async () => {
    const error = plant("unlink", source("a.md"), "EPERM");
    await expect(deleteSource(root, "a.md")).rejects.toBe(error);
    expect((await real.lstat(source("a.md"))).isFile()).toBe(true);
  });
});

describe("sourceFileMissing lookup", () => {
  it("is true when nothing is there and when sources/ is absent", async () => {
    expect(await sourceFileMissing(root, "gone.md")).toBe(true);
    await real.rm(path.join(root, "sources"), { recursive: true });
    expect(await sourceFileMissing(root, "a.md")).toBe(true);
  });

  it("is false for a file, a directory, a link and a dangling link", async () => {
    await real.mkdir(source("dir.md"));
    await real.symlink("a.md", source("link.md"));
    await real.symlink("no-such-target.md", source("dangling.md"));
    for (const id of ["a.md", "dir.md", "link.md", "dangling.md"]) {
      expect([id, await sourceFileMissing(root, id)]).toEqual([id, false]);
    }
  });

  it("rejects with any other lookup error, unchanged", async () => {
    const error = plant("lstat", source("a.md"), "EACCES");
    await expect(sourceFileMissing(root, "a.md")).rejects.toBe(error);
  });
});
