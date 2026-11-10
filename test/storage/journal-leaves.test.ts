/**
 * @file test/storage/journal-leaves.test.ts
 * @description The storage functions the journal's file and page-leaf
 * mechanics moved onto (`src/storage/disk-guarded-leaves.ts`), exercised on a
 * temp directory. Only what had no witness before is here.
 *
 * `readLeafTextNoFollow` is the journal's loader moved whole. Its unusual
 * contract is pinned exactly: every open or read failure is `null`, and the
 * ONE thing that propagates is a rejecting `close`, even after a failure that
 * was turned into `null`. That propagation is what separates the verbatim move
 * from wrapping an existing read in a `catch`, so it gets the one narrow module
 * mock in this file.
 *
 * The other functions are one call each to an existing primitive, so they are
 * compared WITH that primitive on real files rather than against expectations
 * written from memory. The unguarded ones are shown to be unguarded: a rename
 * replaces an existing destination, and failures arrive as raw errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** What the wrapped opener should sabotage on the handles it returns. */
const fault = (() => ({ close: false, read: false }))();

// Snapshot real modules before mock.module replaces them for this file.
const realUtilsNoFollowOpen = { ...(await import("../../src/utils/no-follow-open.js")) };

vi.mock("../../src/utils/no-follow-open.js", async () => {
  const actual = realUtilsNoFollowOpen as typeof import("../../src/utils/no-follow-open.js");
  const openFileNoFollow: typeof actual.openFileNoFollow = async (...args) => {
    const handle = await actual.openFileNoFollow(...args);
    const close = handle.close.bind(handle);
    if (fault.read) handle.readFile = (async () => { throw new Error("read sabotaged"); }) as typeof handle.readFile;
    if (fault.close) handle.close = async () => { await close(); throw new Error("close sabotaged"); };
    return handle;
  };
  return { ...actual, openFileNoFollow };
});

import {
  listDirectoryNames, makeDirectoryTree, readConfinedLeafBytes, readConfinedLeafText, readLeafTextNoFollow,
  renameLeafUnguarded, replaceLeafAtomicWithin,
} from "../../src/storage/disk-guarded-leaves.js";
import { atomicWrite } from "../../src/utils/atomic-write.js";
import { readConfinedLeaf, readConfinedLeafBuffer } from "../../src/utils/confined-read.js";

const NOT_UTF8 = Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x0a]);

let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-journal-leaves-")));
  fault.close = false;
  fault.read = false;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** How a promise settled: resolved, or the error's name and code. */
function settlement(work: Promise<unknown>): Promise<string> {
  return work.then(() => "resolved", (error: NodeJS.ErrnoException) => `${error.name}:${error.code ?? error.message}`);
}

describe("readLeafTextNoFollow", () => {
  it("returns text for a regular file and null for an absent leaf, a link and a directory", async () => {
    await writeFile(path.join(base, "batch.json"), "{\n  \"status\": \"pending\"\n}");
    await symlink(path.join(base, "batch.json"), path.join(base, "linked.json"));
    await mkdir(path.join(base, "dir.json"));
    expect(await readLeafTextNoFollow(path.join(base, "batch.json"))).toBe("{\n  \"status\": \"pending\"\n}");
    expect(await readLeafTextNoFollow(path.join(base, "absent.json"))).toBeNull();
    expect(await readLeafTextNoFollow(path.join(base, "linked.json"))).toBeNull();
    expect(await readLeafTextNoFollow(path.join(base, "dir.json"))).toBeNull();
  });

  it("propagates a rejecting close, after a good read and after a read turned into null", async () => {
    await writeFile(path.join(base, "batch.json"), "text");
    fault.read = true;
    expect(await readLeafTextNoFollow(path.join(base, "batch.json"))).toBeNull();
    fault.close = true;
    await expect(readLeafTextNoFollow(path.join(base, "batch.json"))).rejects.toThrow("close sabotaged");
    fault.read = false;
    await expect(readLeafTextNoFollow(path.join(base, "batch.json"))).rejects.toThrow("close sabotaged");
    await expect(readLeafTextNoFollow(path.join(base, "absent.json"))).resolves.toBeNull();
  });
});

/** One confined replacement in its own directory: how it settled and the bytes left at the leaf. */
async function replaceOutcome(
  write: (confineRoot: string, leaf: string, content: string | Uint8Array) => Promise<void>, dir: string, shape: string,
): Promise<string[]> {
  await mkdir(path.join(dir, "root/wiki"), { recursive: true });
  await symlink(path.join(dir, "root"), path.join(dir, "alias"));
  await writeFile(path.join(dir, "root/wiki/page.md"), "old\n");
  const root = shape === "root given through a link" ? path.join(dir, "alias") : path.join(dir, "root");
  const leaf = shape === "leaf outside the given root" ? path.join(dir, "outside.md") : path.join(root, "wiki/page.md");
  const settled = await settlement(write(root, leaf, shape === "bytes that are not UTF-8" ? NOT_UTF8 : "new\n"));
  const bytes = await readFile(leaf).then((found) => found.toString("hex"), () => "absent");
  return [settled, bytes];
}

describe("replaceLeafAtomicWithin against atomicWrite with the same confine root", () => {
  const shapes = ["text", "bytes that are not UTF-8", "leaf outside the given root", "root given through a link"];

  it.each(shapes)("%s", async (shape) => {
    const viaStorage = await replaceOutcome(replaceLeafAtomicWithin, path.join(base, "storage"), shape);
    const viaPrimitive = await replaceOutcome(
      (confineRoot, leaf, content) => atomicWrite(leaf, content, { confineRoot }), path.join(base, "primitive"), shape);
    expect(viaStorage).toEqual(viaPrimitive);
    if (shape === "text") expect(viaStorage).toEqual(["resolved", Buffer.from("new\n").toString("hex")]);
    if (shape === "bytes that are not UTF-8") expect(viaStorage).toEqual(["resolved", NOT_UTF8.toString("hex")]);
    if (shape === "leaf outside the given root") expect(viaStorage[1]).toBe("absent");
  });
});

describe("the confined reads against their primitives, with options passed through", () => {
  it("reads bytes exactly as readConfinedLeafBuffer does", async () => {
    await writeFile(path.join(base, "blob.bin"), NOT_UTF8);
    await symlink(path.join(base, "blob.bin"), path.join(base, "linked.bin"));
    const reads: Array<[string, number, string]> = [
      ["blob.bin", 64, "ok"], ["absent.bin", 64, "absent"], ["linked.bin", 64, "unavailable"], ["blob.bin", NOT_UTF8.length - 1, "unavailable"],
    ];
    for (const [name, cap, kind] of reads) {
      const viaStorage = await readConfinedLeafBytes(base, path.join(base, name), base, cap);
      expect(viaStorage).toEqual(await readConfinedLeafBuffer(base, path.join(base, name), base, cap));
      expect(viaStorage.kind).toBe(kind);
    }
  });

  it("passes the read options through: a hook runs once, and a hard link is refused when asked", async () => {
    const leaf = path.join(base, "page.md");
    await writeFile(leaf, "body\n");
    const hook = vi.fn(async () => {});
    expect(await readConfinedLeafText(base, leaf, base, 64, { afterOpenForTest: hook })).toEqual({ kind: "ok", body: "body\n" });
    expect(hook).toHaveBeenCalledTimes(1);
    await link(leaf, path.join(base, "second-name.md"));
    for (const opts of [{}, { requireSingleLink: true }]) {
      expect(await readConfinedLeafText(base, leaf, base, 64, opts)).toEqual(await readConfinedLeaf(base, leaf, base, 64, opts));
      expect(await readConfinedLeafBytes(base, leaf, base, 64, opts)).toEqual(await readConfinedLeafBuffer(base, leaf, base, 64, opts));
    }
    expect((await readConfinedLeafText(base, leaf, base, 64, { requireSingleLink: true })).kind).toBe("unavailable");
  });
});

describe("the unguarded directory and rename calls", () => {
  it("makes a directory tree, and rejects raw under a regular file", async () => {
    await makeDirectoryTree(path.join(base, "journal/quarantine"));
    await makeDirectoryTree(path.join(base, "journal/quarantine"));
    expect(await listDirectoryNames(path.join(base, "journal"))).toEqual(["quarantine"]);
    await writeFile(path.join(base, "file"), "x");
    expect(await settlement(makeDirectoryTree(path.join(base, "file/child")))).toBe("Error:ENOTDIR");
  });

  it("renames by path, replaces an existing destination, and rejects raw for a missing source", async () => {
    await writeFile(path.join(base, "from.json"), "moved");
    await writeFile(path.join(base, "to.json"), "replaced");
    await renameLeafUnguarded(path.join(base, "from.json"), path.join(base, "to.json"));
    expect(await readFile(path.join(base, "to.json"), "utf-8")).toBe("moved");
    expect(await settlement(renameLeafUnguarded(path.join(base, "from.json"), path.join(base, "to.json")))).toBe("Error:ENOENT");
    expect((await listDirectoryNames(base)).sort()).toEqual(["to.json"]);
    expect(await settlement(listDirectoryNames(path.join(base, "absent")))).toBe("Error:ENOENT");
  });
});
