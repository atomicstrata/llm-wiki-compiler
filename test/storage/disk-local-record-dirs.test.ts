/**
 * @file test/storage/disk-local-record-dirs.test.ts
 * @description The disk implementation of the legacy-compatibility
 * record-directory binding runs the candidate store's incumbent resolution and
 * tolerant reads, and keeps resolution failures apart from read failures.
 *
 * These cases pin what the tolerant candidate reads above the binding rely on:
 * an absent directory is `null`, never an error; an unsafe one is the typed
 * refusal (the SAME class the candidate store has always exported); in-project
 * aliases and a linked root still resolve; a leaf's location is exactly what
 * `candidatePath` returns; a linked leaf is read through only when its target
 * is inside the project; and a missing leaf resolves fine but rejects the read
 * with the raw Node error.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { candidatePath } from "../../src/compiler/candidate-paths.js";
import { UnsafeCandidateDirError as ExportedByCandidateStore } from "../../src/compiler/candidate-store-paths.js";
import { diskLocalRecordDirs } from "../../src/storage/disk-local-record-dirs.js";
import { UnsafeCandidateDirError } from "../../src/storage/disk-record-directory.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";

const QUEUE = ".llmwiki/candidates";

let base: string;
let root: string;
let dirs: LegacyLocalRecordDirs;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-record-dirs-")));
  root = path.join(base, "project");
  await mkdir(path.join(root, QUEUE, "archive"), { recursive: true });
  await mkdir(path.join(base, "outside"));
  await writeFile(path.join(root, QUEUE, "a.json"), "{\"ünï\": 1}", "utf-8");
  await writeFile(path.join(base, "outside", "secret.json"), "OUTSIDE-BYTES", "utf-8");
  dirs = diskLocalRecordDirs(root);
});

afterEach(() => rm(base, { recursive: true, force: true }));

describe("diskLocalRecordDirs directory", () => {
  it("lists entries with their kinds and reports an absent directory as null", async () => {
    await symlink(path.join(root, QUEUE, "a.json"), path.join(root, QUEUE, "link.json"));
    const directory = await dirs.directory(QUEUE);
    expect(await directory!.exists()).toBe(true);
    const entries = (await directory!.listEntries()).sort((left, right) => left.name.localeCompare(right.name));
    expect(entries).toEqual([
      { name: "a.json", kind: "file" }, { name: "archive", kind: "directory" }, { name: "link.json", kind: "link" },
    ]);
    expect(await dirs.directory(".llmwiki/rule-candidates")).toBeNull();
  });

  it("refuses a file in the directory's place and a directory that resolves outside the project", async () => {
    await symlink(path.join(base, "outside"), path.join(root, ".llmwiki", "escaped"));
    await expect(dirs.directory(`${QUEUE}/a.json`)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    await expect(dirs.directory(".llmwiki/escaped")).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    await expect(diskLocalRecordDirs(path.join(base, "no-project")).directory(QUEUE)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(UnsafeCandidateDirError).toBe(ExportedByCandidateStore);
  });

  it("resolves an alias inside the project and a project reached through a linked root", async () => {
    await symlink(path.join(root, QUEUE), path.join(root, ".llmwiki", "alias"));
    await symlink(root, path.join(base, "linked-root"));
    const names = async (binding: LegacyLocalRecordDirs, relDir: string): Promise<string[]> =>
      (await (await binding.directory(relDir))!.listEntries()).map((entry) => entry.name).sort();
    expect(await names(dirs, ".llmwiki/alias")).toEqual(["a.json", "archive"]);
    expect(await names(diskLocalRecordDirs(path.join(base, "linked-root")), QUEUE)).toEqual(["a.json", "archive"]);
  });
});

describe("diskLocalRecordDirs leaf", () => {
  it("locates a leaf exactly where candidatePath does, and reads it as UTF-8", async () => {
    const leaf = await dirs.leaf(QUEUE, "a.json");
    expect(leaf.location).toBe(await candidatePath(root, "a"));
    expect(leaf.location).toBe(path.join(root, QUEUE, "a.json"));
    expect(await leaf.readText()).toBe("{\"ünï\": 1}");
  });

  it("resolves a missing leaf, then rejects only the read, with the raw Node error", async () => {
    const leaf = await dirs.leaf(QUEUE, "missing.json");
    await expect(leaf.readText()).rejects.toMatchObject({ code: "ENOENT", path: path.join(root, QUEUE, "missing.json") });
  });

  it("reads through a linked leaf whose target is inside the project", async () => {
    await symlink(path.join(root, QUEUE, "a.json"), path.join(root, QUEUE, "inside-link.json"));
    expect(await (await dirs.leaf(QUEUE, "inside-link.json")).readText()).toBe("{\"ünï\": 1}");
  });

  it("refuses to resolve a linked leaf that escapes the project, before any read", async () => {
    await symlink(path.join(base, "outside", "secret.json"), path.join(root, QUEUE, "escape.json"));
    await expect(dirs.leaf(QUEUE, "escape.json")).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    await expect(dirs.leaf(".llmwiki/escaped-dir", "a.json")).resolves.toMatchObject({ location: path.join(root, ".llmwiki", "escaped-dir", "a.json") });
  });
});
