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
import { parseOwner, readProcessStartTime } from "../src/utils/lock-owner.js";
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

/**
 * PID 1 — live on every POSIX host, and owned by root.
 *
 * Chosen because it needs no spawn, no sleep and no cleanup, and because it
 * cannot be won by a racing test: it is `init`/`launchd`, it existed before this
 * process and will outlive it, and its PID is never recycled. A pid the test
 * spawned and killed would be the WRONG instrument here — that is the ESRCH case,
 * not the EPERM one.
 *
 * IT ONLY DISCRIMINATES FOR A NON-ROOT OPERATOR, which is why the probe below is
 * asserted rather than assumed: running the suite AS root makes `kill(1, 0)`
 * succeed, and the case would then pass while testing nothing. The assertion
 * turns that into a loud failure instead of a silent vacuous pass.
 */
const FOREIGN_LIVE_PID = 1;

/** What a signal-0 probe of `pid` actually reports — the errno, or success. */
function killProbe(pid: number): string {
  try {
    process.kill(pid, 0);
    return "signalable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "unknown";
  }
}

describe("lock liveness — PID-reuse safety (M8b)", () => {
  it("reclaims a lock whose live PID has a DIFFERENT start identity (PID was reused)", async () => {
    // Our own (alive) PID, but a start identity that cannot match the live
    // process → the holder is a recycled PID → stale → reclaimed.
    //
    // THE RECORDED VALUE IS IN THE VERSIONED FORMAT, and it has to be. This case
    // used to plant a rendered date string, which encoded the assumption the
    // timezone fix removes: that ANY differing string proves reuse. A rendered
    // string is now UNCOMPARABLE rather than mismatched — see the case below —
    // so planting one here would assert the very behaviour that reclaimed live
    // locks from readers in another zone.
    await plant(JSON.stringify({ pid: process.pid, startTime: "unix:1" }));
    expect(await acquireLock(root)).toBe(true);
    expect(await leaf()).toContain(String(process.pid));
  });

  it("preserves public PID-reuse reclamation for a mismatching legacy timestamp", async () => {
    // Public readers compare ambient timestamps. A 1970 timestamp cannot name
    // this process; restoring that comparison avoids stranding old lock files.
    const planted = JSON.stringify({ pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970" });
    await plant(planted);
    expect(await acquireLock(root)).toBe(true);
    expect(await leaf()).not.toBe(planted);
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

  it("does NOT reclaim a lock held by a live process this uid may not signal", async () => {
    // ESRCH AND EPERM ARE NOT THE SAME ANSWER, and nothing here separated them
    // before. `kill(pid, 0)` throws ESRCH when the process is GONE and EPERM when
    // it EXISTS but belongs to another uid — and the kernel had to FIND the
    // process to decide we may not signal it, so EPERM is positive evidence of
    // existence. Reading both as "dead" reclaims a lock a live foreign-uid holder
    // is still using: a service-account or daemon executor, a sudo-launched
    // compile, a CI runner's own project directory.
    expect(killProbe(FOREIGN_LIVE_PID)).toBe("EPERM");
    const startTime = readProcessStartTime(FOREIGN_LIVE_PID);
    expect(startTime).not.toBeNull();
    await plant(JSON.stringify({ pid: FOREIGN_LIVE_PID, startTime }));
    expect(await acquireLock(root)).toBe(false);
  });

  it("STILL reclaims a foreign live PID whose startTime does not match", async () => {
    // The non-regression half, and the reason the fix is narrow: respecting an
    // unsignalable process must not cost the PID-reuse hardening this module
    // exists for. Same foreign PID, recorded identity that cannot be its own —
    // still stale, still reclaimed.
    // THE VERSIONED FORM, and it has to be: a rendered date string is now
    // UNRECOGNISED rather than mismatched, so planting one here would assert
    // that an identity this build cannot read proves the process is gone — the
    // reading the migration guard exists to refuse.
    await plant(JSON.stringify({ pid: FOREIGN_LIVE_PID, startTime: "unix:1" }));
    expect(await acquireLock(root)).toBe(true);
  });

  it("reclaims a leaf whose pid SUCCEEDS as a process GROUP rather than a process", async () => {
    // THE WEDGE THIS BOUND CLOSES, and it is the guard-that-strands class rather
    // than a parsing nicety. POSIX gives `0` and `-1` process-GROUP meaning, so
    // `kill(0, 0)` and `kill(-1, 0)` SUCCEED against the caller's own group —
    // every time, on any host. A planted or corrupt leaf carrying one therefore
    // read ALIVE unconditionally and its lock could never be reclaimed by any
    // evidence, escapable only by deleting the leaf by hand.
    for (const pid of [0, -1]) {
      // The probe really does succeed, so the case is about the bound rather
      // than about a pid that happens not to exist.
      expect(killProbe(pid)).toBe("signalable");
      await plant(JSON.stringify({ pid }));
      expect(await acquireLock(root)).toBe(true);
      await releaseLock(root);
    }
  });

  it("yields NO USABLE OWNER for every pid a signal probe cannot answer about", () => {
    // TESTED ON `parseOwner` DIRECTLY, and that is deliberate rather than lazy.
    // Through `acquireLock` the upper bound is INVISIBLE: an out-of-range pid
    // reclaims whether it is rejected as an unusable shape or admitted and then
    // read as dead via the TypeError. Both roads end at "stale", so a lock-level
    // assertion cannot discriminate the rule it claims to test — the parse result
    // is the only place the difference is observable.
    //
    // The shapes, all measured: `0` and `-1` SUCCEED as process GROUPS; `1.5`
    // and `2147483648` throw `ERR_INVALID_ARG_TYPE`, a TypeError carrying no
    // errno at all.
    for (const pid of [0, -1, 1.5, 2147483648]) {
      expect(parseOwner(JSON.stringify({ pid }))).toBeNull();
    }
    // `parseInt` is why the JSON leg alone was not enough: it yields 0 from "0"
    // and TRUNCATES "1.5" to 1 — a live pid this process can signal, for a leaf
    // that named neither.
    expect(parseOwner("0")).toBeNull();
    expect(parseOwner("1.5")).toBeNull();
    // ANTI-VACUITY, and the boundary in one: the rule is not a blanket reject.
    expect(parseOwner(JSON.stringify({ pid: 2147483647 }))).toEqual({ pid: 2147483647, startTime: undefined });
    expect(parseOwner(String(process.pid))).toEqual({ pid: process.pid });
  });

  it("reclaims a leaf whose pid Node rejects as an ARGUMENT, not as a process", async () => {
    // The end-to-end consequence for the lock. It does NOT discriminate the
    // bound (see above) — it pins that an unusable leaf never wedges the project,
    // whichever way the code arrives at that answer.
    for (const pid of [1.5, 2147483648]) {
      expect(killProbe(pid)).toBe("ERR_INVALID_ARG_TYPE");
      await plant(JSON.stringify({ pid, startTime: "Thu Jan  1 00:00:00 1970" }));
      expect(await acquireLock(root)).toBe(true);
      await releaseLock(root);
    }
  });

  it("applies the bound to the LEGACY bare-decimal leaf too", async () => {
    // `parseInt` is the reason the bound cannot live on the JSON leg alone: it
    // yields 0 from "0" and TRUNCATES "1.5" to 1 — a real, live pid this process
    // can signal, which would have read alive for a leaf that named neither.
    await plant("0");
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
