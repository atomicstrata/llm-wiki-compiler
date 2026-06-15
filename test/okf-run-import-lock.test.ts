// test/okf-run-import-lock.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { LockUnavailableError } from "../src/import/run-errors.js";
import { writeOneDocBundle } from "./fixtures/okf-bundle-fixture.js";

let dir: string;
afterEach(async () => { vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); });

/** Write a live-holder lock file (this process's pid) so acquireLock sees a non-stale lock. */
async function holdLock(root: string): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki", "lock"), String(process.pid), "utf-8");
}

describe("runOkfImport lock contention is silent", () => {
  it("throws LockUnavailableError with no stdout/stderr when the lock is held", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rii-lock-"));
    const b = await writeOneDocBundle(dir);
    await holdLock(dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runOkfImport(dir, b, {})).rejects.toBeInstanceOf(LockUnavailableError);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
