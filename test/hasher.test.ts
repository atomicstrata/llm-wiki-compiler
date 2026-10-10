import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { detectChanges, hashFile, NotRegularFileError } from "../src/compiler/hasher.js";
import type { WikiState } from "../src/utils/types.js";

function emptyState(): WikiState {
  return { version: 1, indexHash: "", sources: {} };
}

describe("hashFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "llmwiki-hash-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a hex SHA-256 hash", async () => {
    const file = path.join(tmpDir, "test.md");
    await writeFile(file, "hello world", "utf-8");
    const hash = await hashFile(file);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.skipIf(process.platform === "win32")("rejects a named pipe instead of waiting on it", async () => {
    const fifo = path.join(tmpDir, "pipe.md");
    // Nothing ever writes to the pipe, so a blocking open would hang until the test times out.
    execFileSync("mkfifo", [fifo]);
    await expect(hashFile(fifo)).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it("rejects a directory as not a regular file", async () => {
    const dir = path.join(tmpDir, "folder.md");
    await mkdir(dir);
    await expect(hashFile(dir)).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it("still reports a missing file as ENOENT", async () => {
    await expect(hashFile(path.join(tmpDir, "absent.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns different hashes for different content", async () => {
    const file1 = path.join(tmpDir, "a.md");
    const file2 = path.join(tmpDir, "b.md");
    await writeFile(file1, "content A", "utf-8");
    await writeFile(file2, "content B", "utf-8");
    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);
    expect(hash1).not.toBe(hash2);
  });
});

describe("detectChanges", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "llmwiki-detect-"));
    await mkdir(path.join(tmpDir, "sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects new files", async () => {
    await writeFile(path.join(tmpDir, "sources", "new.md"), "new content", "utf-8");
    const changes = await detectChanges(tmpDir, emptyState());
    expect(changes).toEqual([{ file: "new.md", status: "new" }]);
  });

  it("detects changed files", async () => {
    const filePath = path.join(tmpDir, "sources", "existing.md");
    await writeFile(filePath, "updated content", "utf-8");

    const state = emptyState();
    state.sources["existing.md"] = {
      hash: "oldhash",
      concepts: [],
      compiledAt: "2026-01-01T00:00:00.000Z",
    };

    const changes = await detectChanges(tmpDir, state);
    expect(changes).toEqual([{ file: "existing.md", status: "changed" }]);
  });

  it("detects unchanged files", async () => {
    const filePath = path.join(tmpDir, "sources", "same.md");
    await writeFile(filePath, "same content", "utf-8");
    const hash = await hashFile(filePath);

    const state = emptyState();
    state.sources["same.md"] = {
      hash,
      concepts: [],
      compiledAt: "2026-01-01T00:00:00.000Z",
    };

    const changes = await detectChanges(tmpDir, state);
    expect(changes).toEqual([{ file: "same.md", status: "unchanged" }]);
  });

  it("detects deleted files", async () => {
    const state = emptyState();
    state.sources["gone.md"] = {
      hash: "somehash",
      concepts: ["concept-a"],
      compiledAt: "2026-01-01T00:00:00.000Z",
    };

    const changes = await detectChanges(tmpDir, state);
    expect(changes).toEqual([{ file: "gone.md", status: "deleted" }]);
  });

  it("returns empty array for empty sources directory", async () => {
    const changes = await detectChanges(tmpDir, emptyState());
    expect(changes).toEqual([]);
  });
});
