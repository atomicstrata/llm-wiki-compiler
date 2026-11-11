/**
 * @file test/storage/bundle-tree-leaves.test.ts
 * @description FIXED outcomes for the four bundle-tree operations in
 * `src/storage/disk-bundle-tree.ts`, on real files, directories and links:
 * the byte size of what a path resolves to, whether a path resolves, a byte
 * copy, and the removal of an entry with everything under it.
 *
 * What is pinned is each function's whole contract, because none of them
 * guards anything and a caller must know exactly what it gets: the size is
 * BYTES and follows a link; "accessible" is true of any kind of entry and
 * false of a dangling link; the copy is undecoded and overwrites; the removal
 * takes a whole tree, succeeds on a missing entry, and removes a LINK without
 * touching the directory it points at.
 *
 * Nothing is mocked here. These are the real calls on a temporary directory.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "bun:test";
import { copyLocationBytes, locationAccessible, locationByteSize, removeTreeForced } from "../../src/storage/disk-bundle-tree.js";

const ACCENTED = "Zoë — café ✓ 理";
const NOT_UTF8 = Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x0d, 0x0a, 0x80]);

/** A fresh empty directory, removed when the test ends; returns a path joiner for it. */
function scratch(): (relative: string) => string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "bundle-tree-leaves-")));
  onTestFinished(() => rmSync(base, { recursive: true, force: true }));
  return (relative) => path.join(base, relative);
}

/** Resolve to the rejection's code, or to "resolved" when the promise fulfils. */
const codeOf = (attempt: Promise<unknown>): Promise<string> => attempt.then(() => "resolved", (error: NodeJS.ErrnoException) => String(error.code));

describe("locationByteSize", () => {
  it("answers bytes, not characters, and follows a link", async () => {
    const at = scratch();
    writeFileSync(at("a.md"), ACCENTED);
    symlinkSync("a.md", at("link.md"));
    expect(ACCENTED.length).toBeLessThan(Buffer.byteLength(ACCENTED));
    expect(await locationByteSize(at("a.md"))).toBe(Buffer.byteLength(ACCENTED));
    expect(await locationByteSize(at("link.md"))).toBe(Buffer.byteLength(ACCENTED));
  });

  it("rejects with the raw error when nothing resolves", async () => {
    const at = scratch();
    symlinkSync("no-such-target.md", at("dangling.md"));
    expect(await codeOf(locationByteSize(at("absent.md")))).toBe("ENOENT");
    expect(await codeOf(locationByteSize(at("dangling.md")))).toBe("ENOENT");
  });
});

describe("locationAccessible", () => {
  it("resolves for a file, a directory and a link to either", async () => {
    const at = scratch();
    writeFileSync(at("a.md"), "x");
    mkdirSync(at("dir"));
    symlinkSync("a.md", at("to-file"));
    symlinkSync("dir", at("to-dir"));
    for (const name of ["a.md", "dir", "to-file", "to-dir"]) expect([name, await codeOf(locationAccessible(at(name)))]).toEqual([name, "resolved"]);
  });

  it("rejects for nothing there and for a dangling link", async () => {
    const at = scratch();
    symlinkSync("no-such-target.md", at("dangling.md"));
    expect(await codeOf(locationAccessible(at("absent.md")))).toBe("ENOENT");
    expect(await codeOf(locationAccessible(at("dangling.md")))).toBe("ENOENT");
  });
});

describe("copyLocationBytes", () => {
  it("copies bytes exactly, including bytes that are not valid UTF-8", async () => {
    const at = scratch();
    writeFileSync(at("source.bin"), NOT_UTF8);
    await copyLocationBytes(at("source.bin"), at("copy.bin"));
    expect(readFileSync(at("copy.bin")).equals(NOT_UTF8)).toBe(true);
  });

  it("overwrites an existing destination and rejects raw for a missing source", async () => {
    const at = scratch();
    writeFileSync(at("source.md"), "new\n");
    writeFileSync(at("dest.md"), "old and longer\n");
    await copyLocationBytes(at("source.md"), at("dest.md"));
    expect(readFileSync(at("dest.md"), "utf8")).toBe("new\n");
    expect(await codeOf(copyLocationBytes(at("absent.md"), at("other.md")))).toBe("ENOENT");
    expect(existsSync(at("other.md"))).toBe(false);
  });
});

describe("removeTreeForced", () => {
  it("removes a nested tree and a single file, and succeeds on a missing entry", async () => {
    const at = scratch();
    mkdirSync(at("bundle/a/b"), { recursive: true });
    for (const name of ["bundle/a/b/c.md", "bundle/top.md", "lone.md"]) writeFileSync(at(name), "x");
    await removeTreeForced(at("bundle"));
    await removeTreeForced(at("lone.md"));
    expect([existsSync(at("bundle")), existsSync(at("lone.md"))]).toEqual([false, false]);
    expect(await codeOf(removeTreeForced(at("never-there")))).toBe("resolved");
  });

  it("removes a link to a directory as a link, leaving the directory and its content", async () => {
    const at = scratch();
    mkdirSync(at("outside"));
    writeFileSync(at("outside/kept.md"), "kept\n");
    symlinkSync(at("outside"), at("link-to-outside"));
    await removeTreeForced(at("link-to-outside"));
    expect(() => lstatSync(at("link-to-outside"))).toThrow(/ENOENT/);
    expect(readFileSync(at("outside/kept.md"), "utf8")).toBe("kept\n");
  });
});
