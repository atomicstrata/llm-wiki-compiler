/**
 * @file test/storage/disk-local-reads.test.ts
 * @description The disk implementation of the legacy-compatibility read
 * binding makes each incumbent call and passes its failure through untouched.
 *
 * These cases pin the properties the callers above the binding rely on: raw
 * Node error codes for absent paths (callers decide what absence means), link
 * behaviour per method, the backend-neutral entry kinds, and the two confined
 * reads' distinct drop reasons with no out-of-tree bytes returned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { diskLocalReads } from "../../src/storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";

let base: string;
let root: string;
let reads: LegacyLocalReads;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-disk-reads-")));
  root = path.join(base, "project");
  await mkdir(path.join(root, "sources", "nested"), { recursive: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "sources", "a.md"), "Ünïcode text\n", "utf-8");
  await writeFile(path.join(root, "sources", "nested", "b.md"), "nested\n", "utf-8");
  await writeFile(path.join(root, "wiki", "concepts", "page.md"), "page body", "utf-8");
  await writeFile(path.join(base, "outside.md"), "OUTSIDE-BYTES", "utf-8");
  reads = diskLocalReads(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The Node error code a rejected read carries. */
async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
  return attempt.then(() => undefined, (error: NodeJS.ErrnoException) => error.code);
}

describe("diskLocalReads plain reads", () => {
  it("reads UTF-8 text and names the same absolute path in its error", async () => {
    expect(await reads.readText("sources/a.md")).toBe("Ünïcode text\n");
    const failure = await reads.readText("sources/missing.md").catch((error: NodeJS.ErrnoException) => error);
    expect(failure).toMatchObject({ code: "ENOENT", path: path.join(root, "sources", "missing.md") });
    expect(reads.locate("sources/missing.md")).toBe(path.join(root, "sources", "missing.md"));
  });

  it("follows links for exists and readText but not for statNoFollow", async () => {
    await symlink(path.join(base, "outside.md"), path.join(root, "sources", "link.md"));
    await symlink(path.join(base, "nowhere.md"), path.join(root, "sources", "dangling.md"));
    expect(await reads.exists("sources/link.md")).toBe(true);
    expect(await reads.readText("sources/link.md")).toBe("OUTSIDE-BYTES");
    expect(await reads.exists("sources/dangling.md")).toBe(false);
    expect(await reads.statNoFollow("sources/dangling.md")).toBe("link");
    expect(await reads.statNoFollow("sources")).toBe("directory");
    expect(await codeOf(reads.statNoFollow("sources/missing.md"))).toBe("ENOENT");
  });

  it("lists names and rejects, rather than defaulting, for an absent directory", async () => {
    expect((await reads.listNames("sources")).sort()).toEqual(["a.md", "nested"]);
    expect(await codeOf(reads.listNames("wiki/queries"))).toBe("ENOENT");
  });
});

describe("diskLocalReads realDirectory", () => {
  it("lists entries with backend-neutral kinds beneath a real directory", async () => {
    await symlink(path.join(base, "outside.md"), path.join(root, "sources", "link.md"));
    const directory = await reads.realDirectory("sources");
    const top = (await directory!.listEntries("")).sort((a, b) => a.name.localeCompare(b.name));
    expect(top).toEqual([
      { name: "a.md", kind: "file" }, { name: "link.md", kind: "link" }, { name: "nested", kind: "directory" },
    ]);
    expect(await directory!.listEntries("nested")).toEqual([{ name: "b.md", kind: "file" }]);
  });

  it("is null for a linked directory, a file, an absent directory and an absent root", async () => {
    await symlink(path.join(root, "sources"), path.join(root, "linked"));
    expect(await reads.realDirectory("linked")).toBeNull();
    expect(await reads.realDirectory("sources/a.md")).toBeNull();
    expect(await reads.realDirectory("absent")).toBeNull();
    expect(await diskLocalReads(path.join(base, "no-project")).realDirectory("sources")).toBeNull();
  });

  it("resolves through a linked root and stays anchored at the canonical directory", async () => {
    await symlink(root, path.join(base, "alias"));
    const directory = await diskLocalReads(path.join(base, "alias")).realDirectory("sources");
    expect((await directory!.listEntries("nested")).map((entry) => entry.name)).toEqual(["b.md"]);
  });
});

describe("diskLocalReads confined reads", () => {
  it("returns a page inside its directory and drops an escaping link without its bytes", async () => {
    await symlink(path.join(base, "outside.md"), path.join(root, "wiki", "concepts", "escape.md"));
    expect(await reads.readConfinedPage("wiki/concepts", "page")).toEqual({ content: "page body" });
    expect(await reads.readConfinedPage("wiki/concepts", "escape")).toEqual({ dropped: "escapes-dir" });
    expect(await reads.readConfinedPage("wiki/concepts", "absent")).toEqual({ dropped: "escapes-dir" });
    expect(await reads.readConfinedFile("wiki/concepts/escape.md")).toEqual({ dropped: "escapes-dir" });
    expect(await reads.readConfinedFile("wiki/concepts/page.md")).toEqual({ content: "page body" });
  });

  it("reads a nested slug under both rules and reports an unresolvable root", async () => {
    await mkdir(path.join(root, "wiki", "concepts", "sub"), { recursive: true });
    await writeFile(path.join(root, "wiki", "concepts", "sub", "deep.md"), "deep", "utf-8");
    expect(await reads.readConfinedPage("wiki/concepts", "sub/deep")).toEqual({ content: "deep" });
    expect(await reads.readConfinedFile("wiki/concepts/sub/deep.md")).toEqual({ content: "deep" });
    expect(await diskLocalReads(path.join(base, "no-project")).readConfinedPage("wiki/concepts", "page"))
      .toEqual({ dropped: "no-root" });
  });
});
