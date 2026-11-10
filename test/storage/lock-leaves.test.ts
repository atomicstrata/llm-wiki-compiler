/**
 * @file test/storage/lock-leaves.test.ts
 * @description The two physical writes the project lock's publication moved
 * onto (`src/storage/disk-private-leaves.ts`), and the lock itself through the
 * three ways a caller can spell one project root.
 *
 * Every expectation is a FIXED outcome. The create's mode is computed from the
 * process umask, not read back from another call; the owner is checked by
 * reading the lock file's own text; nothing is compared with the function or
 * the serializer under test.
 *
 * Neither write is hardened and the tests say so by what they pin: the create
 * guarantees only that an existing name, a link included, is never opened or
 * replaced; the link guarantees only that an existing destination is never
 * replaced. A failing `close` must reject, which is checked with a handle that
 * really closes before it throws.
 *
 * The root-form test is about policy the move must not disturb: a real, a
 * linked and a relative spelling of one root publish the same lock file and
 * share one queue, so a waiter under one spelling is released by another.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** When set, the next opened handle really closes and then reports failure. */
const closeFault = (() => ({ armed: false }))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("node:fs/promises")) };

vi.mock("node:fs/promises", async () => {
  const actual = realFsPromises as typeof import("node:fs/promises");
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    if (!closeFault.armed) return handle;
    const reallyClose = handle.close.bind(handle);
    handle.close = async () => { await reallyClose(); throw new Error("close failed after closing"); };
    return handle;
  };
  return { ...actual, open };
});

import { createPrivateLeafExclusive, linkPrivateLeafNoReplace } from "../../src/storage/disk-private-leaves.js";
import { acquireLock, acquireLockBlocking, releaseLock } from "../../src/utils/lock.js";

const RECORD = "{\"pid\":4242,\"startTime\":\"then\"}";
const DEFAULT_CREATE_MODE = 0o666;
const PERMISSION_BITS = 0o777;

let base: string;
const at = (name: string): string => path.join(base, name);

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-lock-leaves-")));
  closeFault.armed = false;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The rejection's error name and code, or "resolved". */
function settled(work: Promise<unknown>): Promise<string> {
  return work.then(() => "resolved", (error: NodeJS.ErrnoException) => `${error.name}:${error.code ?? error.message}`);
}

describe("createPrivateLeafExclusive", () => {
  it("writes the exact text with the default mode filtered by the umask", async () => {
    await createPrivateLeafExclusive(at("lock.scratch"), RECORD);
    expect(await readFile(at("lock.scratch"), "utf-8")).toBe(RECORD);
    expect((await stat(at("lock.scratch"))).mode & PERMISSION_BITS).toBe(DEFAULT_CREATE_MODE & ~process.umask());
  });

  it("never opens or replaces an existing name, a link included, and rejects raw", async () => {
    await writeFile(at("taken"), "kept");
    await symlink(at("nowhere"), at("dangling"));
    expect(await settled(createPrivateLeafExclusive(at("taken"), RECORD))).toBe("Error:EEXIST");
    expect(await settled(createPrivateLeafExclusive(at("dangling"), RECORD))).toBe("Error:EEXIST");
    expect(await settled(createPrivateLeafExclusive(at("missing/leaf"), RECORD))).toBe("Error:ENOENT");
    expect(await readFile(at("taken"), "utf-8")).toBe("kept");
    expect(await readlink(at("dangling"))).toBe(at("nowhere"));
  });

  it("rejects when close fails, leaving the written leaf behind", async () => {
    closeFault.armed = true;
    expect(await settled(createPrivateLeafExclusive(at("leaf"), RECORD))).toBe("Error:close failed after closing");
    closeFault.armed = false;
    expect(await readFile(at("leaf"), "utf-8")).toBe(RECORD);
  });
});

describe("linkPrivateLeafNoReplace", () => {
  it("gives the file a second name and never replaces an existing destination", async () => {
    await writeFile(at("scratch"), RECORD);
    await linkPrivateLeafNoReplace(at("scratch"), at("lock"));
    const [scratch, lock] = [await stat(at("scratch")), await stat(at("lock"))];
    expect([lock.ino, lock.nlink]).toEqual([scratch.ino, 2]);
    await writeFile(at("other"), "a different record");
    expect(await settled(linkPrivateLeafNoReplace(at("other"), at("lock")))).toBe("AtomicWriteCollisionError:atomic no-replace destination already exists");
    expect(await readFile(at("lock"), "utf-8")).toBe(RECORD);
    expect(await settled(linkPrivateLeafNoReplace(at("absent"), at("elsewhere")))).toBe("Error:ENOENT");
  });
});

describe("the project lock through a real, a linked and a relative root", () => {
  /** The pid in the lock file's own text, read without the code under test. */
  async function ownerPid(root: string): Promise<unknown> {
    return (JSON.parse(await readFile(path.join(root, ".llmwiki/lock"), "utf-8")) as { pid?: unknown }).pid;
  }

  it("publishes one lock file and shares one queue across the three spellings", async () => {
    const real = at("project");
    await mkdir(real);
    await symlink(real, at("linked"));
    const cwd = process.cwd();
    try {
      process.chdir(base);
      for (const spelling of [real, at("linked"), "project"]) {
        expect(await acquireLock(spelling, { quiet: true })).toBe(true);
        expect(await ownerPid(real)).toBe(process.pid);
        expect(await acquireLock(real, { quiet: true })).toBe(false);
        await releaseLock(spelling);
        await expect(stat(path.join(real, ".llmwiki/lock"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await acquireLockBlocking(real);
      let waiterHasIt = false;
      const waiter = acquireLockBlocking(at("linked"), { timeoutMs: 5_000, intervalMs: 5 }).then(() => { waiterHasIt = true; });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(waiterHasIt).toBe(false);
      await releaseLock("project");
      await waiter;
      expect(await ownerPid(real)).toBe(process.pid);
      await releaseLock(real);
    } finally {
      process.chdir(cwd);
    }
  });
});
