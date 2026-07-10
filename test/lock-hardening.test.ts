/**
 * @file test/lock-hardening.test.ts
 * @description Audit hardening of the lock leaf (`.llmwiki/lock`):
 *
 * 1. STALE RECLAMATION (the dead-PID reclaim engine): a leaf holding a dead PID is
 *    reclaimed (with the visible warning), a leaf holding OUR pid is respected (not
 *    stolen), and garbage/empty content is treated stale and reclaimed.
 * 2. SYMLINKED LEAF (the security fix): a planted `.llmwiki/lock` → out-of-tree
 *    victim is NEVER followed/read by `isLockStale`/`acquireLock`, and `releaseLock`
 *    NEVER deletes the out-of-tree victim through it. Pre-fix (`isLockStale`'s bare
 *    `readFile`, `releaseLock`'s unconditional `unlink`) these FAIL.
 * 3. releaseLock OWNERSHIP: a lock owned by a DIFFERENT pid is NOT deleted (no-op);
 *    a lock owned by `process.pid` IS deleted. The acquire→release round-trip still
 *    holds (via the shared `expectLockAcquireRelease`).
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdir, rm, symlink, writeFile, readFile } from "fs/promises";
import path from "path";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { LLMWIKI_DIR } from "../src/utils/constants.js";
import {
  makeRootWithOutside,
  cleanupRootWithOutside,
  exists,
  existsUnder,
  expectLockAcquireRelease,
} from "./trust/fixture.js";

const LOCK_REL = `${LLMWIKI_DIR}/lock`;
/** A PID very unlikely to be a live process — the canonical "dead holder". */
const DEAD_PID = 999999;
/** A different-from-us numeric owner for the foreign-lock no-op assertions. */
const FOREIGN_PID = DEAD_PID;

let root = "";
let outsideDir = "";

beforeEach(async () => {
  ({ root, outsideDir } = await makeRootWithOutside("lock-hardening-"));
});

afterEach(async () => {
  await cleanupRootWithOutside({ root, outsideDir });
});

/** Pre-create `.llmwiki/` and write `content` as the lock leaf. */
async function plantLock(content: string): Promise<string> {
  const lockPath = path.join(root, LOCK_REL);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, content, "utf-8");
  return lockPath;
}

describe("lock hardening — stale reclamation engine", () => {
  it("reclaims a lock held by a DEAD pid and warns", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await plantLock(String(DEAD_PID));
    expect(await acquireLock(root)).toBe(true);
    const reclaimed = log.mock.calls.flat().join(" ").includes("Reclaimed stale lock");
    expect(reclaimed).toBe(true);
    log.mockRestore();
  });

  it("respects a lock held by OUR pid (not stolen)", async () => {
    await plantLock(String(process.pid));
    expect(await acquireLock(root)).toBe(false);
  });

  it("treats garbage lock content as stale and reclaims it", async () => {
    await plantLock("not-a-pid");
    expect(await acquireLock(root)).toBe(true);
    // We now own it: the leaf records our pid (new `{pid, startTime}` owner format).
    const owner = JSON.parse((await readFile(path.join(root, LOCK_REL), "utf-8")).trim()) as { pid: number };
    expect(owner.pid).toBe(process.pid);
  });

  it("treats empty lock content as stale and reclaims it", async () => {
    await plantLock("");
    expect(await acquireLock(root)).toBe(true);
  });
});

describe("lock hardening — symlinked lock leaf (security)", () => {
  /** Plant `.llmwiki/lock` as a symlink to an out-of-tree victim file. */
  async function plantSymlinkedLeaf(victimBytes: string): Promise<string> {
    const victim = path.join(outsideDir, "victim");
    await writeFile(victim, victimBytes, "utf-8");
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await symlink(victim, path.join(root, LOCK_REL), "file");
    return victim;
  }

  it("acquireLock does NOT follow a symlinked leaf to the out-of-tree victim", async () => {
    // Victim holds OUR pid: a bare readFile would follow it, parse a LIVE pid, and
    // refuse to acquire. The no-follow reader sees ELOOP → stale → reclaims cleanly.
    const victim = await plantSymlinkedLeaf(String(process.pid));
    expect(await acquireLock(root)).toBe(true);
    // The victim bytes were never used as the owner (we did not treat it as live),
    // and the victim file itself is untouched.
    expect(await readFile(victim, "utf-8")).toBe(String(process.pid));
  });

  it("releaseLock does NOT delete the out-of-tree victim through a symlinked leaf", async () => {
    const victim = await plantSymlinkedLeaf("do-not-delete");
    await releaseLock(root);
    expect(await exists(victim)).toBe(true);
    expect(await readFile(victim, "utf-8")).toBe("do-not-delete");
  });
});

describe("lock hardening — releaseLock ownership guard", () => {
  it("does NOT delete a lock owned by a DIFFERENT pid", async () => {
    await plantLock(String(FOREIGN_PID));
    await releaseLock(root);
    expect(await existsUnder(root, LOCK_REL)).toBe(true);
  });

  it("DOES delete a lock owned by our pid", async () => {
    await plantLock(String(process.pid));
    await releaseLock(root);
    expect(await existsUnder(root, LOCK_REL)).toBe(false);
  });

  it("acquire → release round-trip still works (regression)", async () => {
    await expectLockAcquireRelease(root);
  });
});
