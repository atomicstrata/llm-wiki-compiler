/**
 * @file test/storage/shared-page-reads.test.ts
 * @description Contract of the confined-read sharing window compile opens:
 * inside it, a file read once is reused while the file on disk is provably
 * unchanged, and read afresh (through the full confined read) after any
 * rewrite, in-place edit, delete or link swap; outside it, every ask reads.
 *
 * A full confined read ends with one post-open realpath of the page, so the
 * count of realpath calls on the page's path is the count of full reads.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfinedExactFile } from "../../src/storage/disk-local-reads.js";
import { withSharedPageReads } from "../../src/storage/shared-page-reads.js";

let dir: string;
let page: string;
let realpath: ReturnType<typeof spyOn>;

/** How many full confined reads of `page` were made so far. */
const fullReads = (): number => realpath.mock.calls.filter(([target]: unknown[]) =>String(target) === page).length;
const read = () => readConfinedExactFile(dir, page);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-shared-reads-")));
  page = path.join(dir, "a.md");
  fs.writeFileSync(page, "first\n");
  realpath = spyOn(fs, "realpathSync");
});

afterEach(() => {
  realpath.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("shared confined reads", () => {
  it("reads every time outside a window", async () => {
    await read();
    await read();
    expect(fullReads()).toBe(2);
  });

  it("reuses an unchanged file's read inside a window", async () => {
    const [first, second] = await withSharedPageReads(async () => [await read(), await read()]);
    expect(second).toEqual({ content: "first\n" });
    expect(second).toBe(first);
    expect(fullReads()).toBe(1);
  });

  it("reads again after an atomic replace", async () => {
    const after = await withSharedPageReads(async () => {
      await read();
      fs.writeFileSync(`${page}.tmp`, "second\n");
      fs.renameSync(`${page}.tmp`, page);
      return read();
    });
    expect(after).toEqual({ content: "second\n" });
    expect(fullReads()).toBe(2);
  });

  it("reads again after a same-size in-place edit", async () => {
    const after = await withSharedPageReads(async () => {
      await read();
      fs.writeFileSync(page, "FIRST\n");
      // Force a visibly different modified time even on a coarse clock.
      fs.utimesSync(page, new Date(), new Date(Date.now() + 5_000));
      return read();
    });
    expect(after).toEqual({ content: "FIRST\n" });
  });

  it("does not answer for a deleted file", async () => {
    const after = await withSharedPageReads(async () => {
      await read();
      fs.unlinkSync(page);
      return read();
    });
    expect(after).toEqual({ dropped: "escapes-dir" });
  });

  it("does not reuse across a swap to a link pointing outside the directory", async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-outside-")));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "secret\n");
      const after = await withSharedPageReads(async () => {
        await read();
        fs.unlinkSync(page);
        fs.symlinkSync(path.join(outside, "secret.md"), page);
        return read();
      });
      expect(after).toEqual({ dropped: "escapes-dir" });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("starts each window empty", async () => {
    await withSharedPageReads(read);
    await withSharedPageReads(read);
    expect(fullReads()).toBe(2);
  });
});
