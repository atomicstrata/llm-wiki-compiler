/**
 * @file test/storage/disk-local-records.test.ts
 * @description The disk implementation of the legacy-compatibility record
 * binding makes each incumbent call and passes its failure through untouched.
 *
 * These cases pin what the compile-state module above the binding relies on:
 * `exists` follows links and never rejects; the read refuses a symlinked leaf
 * with the opener's own error rather than reading through it; the copy and the
 * atomic write land on the same absolute paths as before; and the atomic write
 * refuses a symlinked leaf that escapes the project instead of writing through it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { diskLocalRecords } from "../../src/storage/disk-local-records.js";
import type { LegacyLocalRecords } from "../../src/storage/legacy-local-records.js";

const RECORD = ".llmwiki/state.json";

let base: string;
let root: string;
let records: LegacyLocalRecords;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-disk-records-")));
  root = path.join(base, "project");
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(base, "outside.json"), "OUTSIDE-BYTES", "utf-8");
  records = diskLocalRecords(root);
});

afterEach(() => rm(base, { recursive: true, force: true }));

describe("diskLocalRecords reads", () => {
  it("reads a regular record as UTF-8 and locates it at the same absolute path", async () => {
    await writeFile(path.join(root, RECORD), "{\"ünï\": 1}", "utf-8");
    expect(await records.exists(RECORD)).toBe(true);
    expect(await records.readTextNoFollow(RECORD)).toBe("{\"ünï\": 1}");
    expect(records.locate(RECORD)).toBe(path.join(root, ".llmwiki", "state.json"));
  });

  it("reports an absent record as not existing and rejects the read with ENOENT", async () => {
    expect(await records.exists(RECORD)).toBe(false);
    await expect(records.readTextNoFollow(RECORD)).rejects.toMatchObject({ code: "ENOENT", path: path.join(root, RECORD) });
  });

  it("sees a symlinked leaf as existing but refuses to read through it", async () => {
    await symlink(path.join(base, "outside.json"), path.join(root, RECORD));
    expect(await records.exists(RECORD)).toBe(true);
    await expect(records.readTextNoFollow(RECORD)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("refuses a directory at the record's path instead of reading it", async () => {
    await mkdir(path.join(root, RECORD));
    await expect(records.readTextNoFollow(RECORD)).rejects.toBeInstanceOf(Error);
  });
});

describe("diskLocalRecords writes", () => {
  it("copies a record's exact bytes to the backup path and rejects when there is nothing to copy", async () => {
    await writeFile(path.join(root, RECORD), "{ broken", "utf-8");
    await records.copy(RECORD, `${RECORD}.bak`);
    expect(await readFile(path.join(root, `${RECORD}.bak`), "utf-8")).toBe("{ broken");
    await expect(records.copy(".llmwiki/absent.json", ".llmwiki/absent.json.bak")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a record atomically and leaves no temp file beside it", async () => {
    await writeFile(path.join(root, RECORD), "old", "utf-8");
    await records.writeAtomic(RECORD, "new text");
    expect(await readFile(path.join(root, RECORD), "utf-8")).toBe("new text");
    expect(await readdir(path.join(root, ".llmwiki"))).toEqual(["state.json"]);
  });

  it("refuses to write through a symlinked leaf that escapes the project, and writes nothing", async () => {
    await symlink(path.join(base, "outside.json"), path.join(root, RECORD));
    await expect(records.writeAtomic(RECORD, "inside")).rejects.toThrow(/path escapes project root/u);
    expect(await readFile(path.join(base, "outside.json"), "utf-8")).toBe("OUTSIDE-BYTES");
    expect((await lstat(path.join(root, RECORD))).isSymbolicLink()).toBe(true);
    expect(await readdir(path.join(root, ".llmwiki"))).toEqual(["state.json"]);
  });
});
