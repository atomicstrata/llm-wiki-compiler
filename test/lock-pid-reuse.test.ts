/**
 * @file test/lock-pid-reuse.test.ts
 * @description PID-reuse-safe lock liveness (M8b) + bounded-blocking acquire contract.
 *
 * The lock leaf now records `{pid, startTime}`. Staleness is: the PID is dead, OR
 * the PID is alive but its recorded start time differs from the live process's
 * CURRENT start time (the PID was REUSED — the wedge this fix closes). A leaf with
 * a MATCHING live PID+startTime is respected. A LEGACY bare-PID leaf (no startTime)
 * keeps the prior PID-only behavior (back-compat). `acquireLockBlocking` RETRIES a
 * transiently-held lock until it frees, then throws `LockBusyError` after its bound.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import path from "path";
import { acquireLock, acquireLockBlocking, releaseLock, LockBusyError } from "../src/utils/lock.js";
import { readProcessStartTime } from "../src/utils/lock-owner.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import { makeRootWithOutside, cleanupRootWithOutside, existsUnder } from "./trust/fixture.js";

const LOCK_REL = `${LLMWIKI_DIR}/lock`;
let root = "";
let outsideDir = "";

beforeEach(async () => { ({ root, outsideDir } = await makeRootWithOutside("lock-pid-reuse-")); });
afterEach(async () => { await cleanupRootWithOutside({ root, outsideDir }); });

/** Plant `.llmwiki/lock` with raw `content` as the leaf. */
async function plant(content: string): Promise<void> {
  const lockPath = path.join(root, LOCK_REL);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, content, "utf-8");
}

/** The leaf content as currently on disk. */
async function leaf(): Promise<string> {
  return (await readFile(path.join(root, LOCK_REL), "utf-8")).trim();
}

describe("lock liveness — PID-reuse safety (M8b)", () => {
  it("reclaims a lock whose live PID has a DIFFERENT startTime (PID was reused)", async () => {
    // Our own (alive) PID, but a start time that cannot match the live process →
    // the holder is a recycled PID → stale → reclaimed.
    await plant(JSON.stringify({ pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970" }));
    expect(await acquireLock(root)).toBe(true);
    expect(await leaf()).toContain(String(process.pid));
  });

  it("respects a lock with a MATCHING live PID + startTime (not reclaimed)", async () => {
    const startTime = readProcessStartTime(process.pid);
    expect(startTime).not.toBeNull();
    await plant(JSON.stringify({ pid: process.pid, startTime }));
    expect(await acquireLock(root)).toBe(false);
  });

  it("respects a LEGACY bare-PID live leaf (no startTime) — back-compat", async () => {
    await plant(String(process.pid));
    expect(await acquireLock(root)).toBe(false);
  });

  it("reclaims a legacy bare-PID leaf with a DEAD pid (unchanged behavior)", async () => {
    await plant("999999");
    expect(await acquireLock(root)).toBe(true);
  });

  it("writes the new {pid, startTime} owner record on a fresh acquire", async () => {
    expect(await acquireLock(root)).toBe(true);
    const parsed = JSON.parse(await leaf()) as { pid: number; startTime?: string };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.startTime).toBe("string");
    await releaseLock(root);
    expect(await existsUnder(root, LOCK_REL)).toBe(false);
  });
});

describe("acquireLockBlocking — bounded contract", () => {
  it("RETRIES a transiently-held lock then succeeds once it frees", async () => {
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    // Free the lock shortly after the blocking acquire starts polling.
    setTimeout(() => { void releaseLock(root); }, 40);
    await acquireLockBlocking(root, { timeoutMs: 2000, intervalMs: 5 });
    await releaseLock(root); // acquired successfully (no throw)
  });

  it("throws LockBusyError after the bound when the lock never frees", async () => {
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      const startedAt = Date.now();
      await expect(acquireLockBlocking(root, { timeoutMs: 60, intervalMs: 5 })).rejects.toBeInstanceOf(LockBusyError);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55);
    } finally {
      await releaseLock(root);
    }
  });
});
