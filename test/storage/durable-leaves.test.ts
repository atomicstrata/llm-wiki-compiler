/**
 * @file test/storage/durable-leaves.test.ts
 * @description The eight local-disk operations in
 * `src/storage/disk-durable-leaves.ts`, on real entries in a temp directory.
 * Every expectation is a FIXED outcome written down from what the product
 * install, the package store and the binding writer did inline before the
 * move; nothing is compared with the primitive a function happens to call.
 *
 * One narrow wrapper around `open` lets a test make ONE watched directory's
 * `sync` fail and counts that directory's opens and closes. Everything else
 * is the real filesystem.
 *
 * What these cases show is BEHAVIOUR, not durability: that a sync was asked
 * for, tolerated or refused, and what was left on disk. Whether bytes reached
 * a device, or survive a crash, is not observable here and is not claimed.
 */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

/** The one directory whose opens are counted, and the error its `sync` should raise (if any). */
const watch = { dir: "", syncError: null as Error | null, opened: 0, closed: 0 };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("node:fs/promises")) };

vi.mock("node:fs/promises", async () => {
  const actual = realFsPromises;
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (args[0] !== watch.dir) return handle;
    watch.opened += 1;
    const close = handle.close.bind(handle);
    const failure = watch.syncError;
    if (failure) handle.sync = async () => { throw failure; };
    handle.close = async () => { watch.closed += 1; return close(); };
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

import {
  createLeafNoReplaceDurableWith, locationByteSizeNoFollow, makeDirectoryTreeWithMode, makeUniqueDirectory,
  readCappedBytesClassified, replaceLeafAtomicWith, syncDirectoryBestEffort, writeLocationBytesWithMode,
} from "../../src/storage/disk-durable-leaves.js";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write.js";

const BYTES = Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x0a]);
const PERMISSIONS = 0o777;

let root: string;
const at = (...names: string[]): string => path.join(root, ...names);
const modeOf = async (file: string): Promise<number> => (await stat(file)).mode & PERMISSIONS;
const withCode = (code: string): Error => Object.assign(new Error(`${code}: sabotaged`), { code });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-durable-leaves-")));
  Object.assign(watch, { dir: "", syncError: null, opened: 0, closed: 0 });
  await writeFile(at("leaf.bin"), BYTES);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the two reads", () => {
  it("classifies a capped byte read and never rejects", async () => {
    await symlink(at("leaf.bin"), at("linked.bin"));
    expect(await readCappedBytesClassified(at("leaf.bin"), BYTES.byteLength)).toEqual({ kind: "ok", body: BYTES });
    expect(await readCappedBytesClassified(at("missing.bin"), 64)).toEqual({ kind: "absent" });
    expect(await readCappedBytesClassified(at("linked.bin"), 64)).toEqual({ kind: "unavailable" });
    expect(await readCappedBytesClassified(root, 64)).toEqual({ kind: "unavailable" });
    expect(await readCappedBytesClassified(at("leaf.bin"), BYTES.byteLength - 1)).toEqual({ kind: "unavailable" });
  });

  it("sizes the entry itself: for a link, the link's own size and not its target's", async () => {
    await writeFile(at("large.bin"), Buffer.alloc(4096));
    await symlink(at("large.bin"), at("linked.bin"));
    expect(await locationByteSizeNoFollow(at("leaf.bin"))).toBe(BYTES.byteLength);
    expect(await locationByteSizeNoFollow(at("linked.bin"))).toBe(Buffer.byteLength(at("large.bin")));
    await expect(locationByteSizeNoFollow(at("missing.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the three creations", () => {
  it("makes a different, existing directory for each call with one prefix", async () => {
    const first = await makeUniqueDirectory(at("scratch-"));
    const second = await makeUniqueDirectory(at("scratch-"));
    expect(first).not.toBe(second);
    expect((await readdir(root)).filter((name) => name.startsWith("scratch-")).sort())
      .toEqual([path.basename(first), path.basename(second)].sort());
  });

  it("creates a directory tree and a file with the requested permission bits", async () => {
    const umask = process.umask();
    await makeDirectoryTreeWithMode(at("deep", "er"), 0o700);
    await writeLocationBytesWithMode(at("deep", "er", "new.bin"), BYTES, 0o600);
    expect(await modeOf(at("deep", "er"))).toBe(0o700 & ~umask);
    expect(await modeOf(at("deep", "er", "new.bin"))).toBe(0o600 & ~umask);
    expect(await readFile(at("deep", "er", "new.bin"))).toEqual(BYTES);
  });

  it("overwrites an existing file, which keeps the mode it already had", async () => {
    const before = await modeOf(at("leaf.bin"));
    await writeLocationBytesWithMode(at("leaf.bin"), Buffer.from("replaced"), 0o600);
    expect(await readFile(at("leaf.bin"), "utf-8")).toBe("replaced");
    expect(await modeOf(at("leaf.bin"))).toBe(before);
    await expect(makeDirectoryTreeWithMode(root, 0o700)).resolves.toBeUndefined();
  });
});

describe("syncDirectoryBestEffort", () => {
  it("resolves for a real directory and for a missing one, closing what it opened", async () => {
    watch.dir = root;
    await expect(syncDirectoryBestEffort(root)).resolves.toBeUndefined();
    await expect(syncDirectoryBestEffort(at("missing"))).resolves.toBeUndefined();
    expect([watch.opened, watch.closed]).toEqual([1, 1]);
  });

  it.each(["EINVAL", "EPERM", "ENOTSUP", "ENOENT"])("tolerates an injected %s from the sync and still closes", async (code) => {
    Object.assign(watch, { dir: root, syncError: withCode(code) });
    await expect(syncDirectoryBestEffort(root)).resolves.toBeUndefined();
    expect([watch.opened, watch.closed]).toEqual([1, 1]);
  });

  it("rejects with the raw error for any other injected sync failure, and still closes", async () => {
    const failure = withCode("EIO");
    Object.assign(watch, { dir: root, syncError: failure });
    await expect(syncDirectoryBestEffort(root)).rejects.toBe(failure);
    expect([watch.opened, watch.closed]).toEqual([1, 1]);
  });
});

describe("the two atomic writers, with the caller's own options", () => {
  it("never replaces an existing destination in a create-only write", async () => {
    const opts = { confineRoot: root, exactParent: true, mode: 0o600 };
    await createLeafNoReplaceDurableWith(at("store", "fresh.bin"), BYTES, opts);
    expect(await readFile(at("store", "fresh.bin"))).toEqual(BYTES);
    await expect(createLeafNoReplaceDurableWith(at("leaf.bin"), Buffer.from("other"), opts))
      .rejects.toBeInstanceOf(AtomicWriteCollisionError);
    expect(await readFile(at("leaf.bin"))).toEqual(BYTES);
  });

  it("refuses a redirected parent when the caller asks for an exact parent", async () => {
    await mkdir(at("real"));
    await symlink(at("real"), at("alias"));
    await expect(replaceLeafAtomicWith(at("alias", "leaf.bin"), BYTES, { confineRoot: root, exactParent: true }))
      .rejects.toThrow();
    expect(await readdir(at("real"))).toEqual([]);
  });

  it("replaces a leaf with the new bytes and leaves no temp beside it", async () => {
    await replaceLeafAtomicWith(at("leaf.bin"), Buffer.from("replaced"), { confineRoot: root, durable: true });
    expect(await readFile(at("leaf.bin"), "utf-8")).toBe("replaced");
    expect(await readdir(root)).toEqual(["leaf.bin"]);
  });
});
