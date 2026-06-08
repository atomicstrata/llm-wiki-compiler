/**
 * @file test/sdk/create-wiki-root.test.ts
 * @description Tests for createWiki root-path validation.
 *
 * Covers two contract cases:
 *  1. A non-existent root is VALID — ingestText will create `sources/` via recursive mkdir.
 *  2. A root that exists but is NOT a directory (e.g. a regular file) must THROW
 *     synchronously with a clear message during construction.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";

describe("createWiki root validation", () => {
  it("accepts a non-existent root and ingestText creates sources/ under it", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "wiki-sdk-root-missing-"));
    // Use a sub-path that does not exist yet
    const root = path.join(base, "fresh-wiki");

    // Construction must not throw
    const wiki = createWiki({ root });

    // ingestText writes into root/sources/, creating the directory tree
    await wiki.ingestText({ title: "Hello", text: "world content here" });

    const files = await readdir(path.join(root, "sources"));
    expect(files.length).toBe(1);
  });

  it("throws when root exists but is a file, not a directory", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "wiki-sdk-root-file-"));
    const filePath = path.join(base, "not-a-dir.txt");
    await writeFile(filePath, "I am a file", "utf-8");

    expect(() => createWiki({ root: filePath })).toThrowError(
      /not a directory/i,
    );
  });
});
