/**
 * @file test/lock-unavailable-fail-closed.test.ts
 * @description A lock read that reports unavailable cannot prove its owner dead.
 * A single injected LockIo keeps this contention deterministic and tracks every unlink.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import { AtomicWriteCollisionError } from "../src/utils/atomic-write-no-replace-durable.js";
import { acquireLockFrom, releaseLockFrom, type LockHost, type LockIo } from "../src/utils/lock.js";

const ROOT = "/fixture/project";
const LOCK = path.join(ROOT, ".llmwiki", "lock");
const SELF = 42;
const LIVE = 7;

/** In-memory physical answers with one optionally unreadable authoritative leaf. */
function lockIo(unavailableLeaf?: string) {
  const files = new Map<string, string>();
  const removed: string[] = [];
  let entropy = 0;
  const io: LockIo = {
    confineTarget: async (target, root) => path.join(root, target),
    makeDirectoryTree: async () => {},
    safeRealPath: async (location) => location,
    probeEntryNoFollow: async () => {},
    realPath: async (location) => location,
    readLeafCapped: async (leaf) => leaf === unavailableLeaf ? { kind: "unavailable" } :
      files.has(leaf) ? { kind: "ok", body: files.get(leaf)! } : { kind: "absent" },
    createLeafExclusive: async (leaf, text) => { if (files.has(leaf)) throw new Error("occupied"); files.set(leaf, text); },
    linkLeafNoReplace: async (from, to) => { if (files.has(to)) throw new AtomicWriteCollisionError(); files.set(to, files.get(from)!); },
    removeLeaf: async (leaf) => { if (!files.delete(leaf)) throw new Error("absent"); removed.push(leaf); },
  };
  const host: LockHost = {
    processId: () => SELF, serializeOwner: (pid) => JSON.stringify({ pid }),
    isOwnerProcessStale: (owner) => owner.pid !== SELF && owner.pid !== LIVE,
    entropy: (bytes) => (++entropy).toString(16).padStart(bytes * 2, "0"),
    now: () => 0, sleep: async () => {}, admit: async () => () => {},
    park: () => {}, releaseParked: () => {}, hasParked: () => false, status: () => {},
  };
  return { io, host, files, removed };
}

describe("an unavailable lock owner read", () => {
  it("keeps a live holder's occupied lock and never enters reclamation", async () => {
    const fixture = lockIo(LOCK);
    const original = JSON.stringify({ pid: LIVE });
    fixture.files.set(LOCK, original);
    expect(await acquireLockFrom(fixture.io, fixture.host, ROOT, { quiet: true })).toBe(false);
    expect(fixture.files.get(LOCK)).toBe(original);
    expect(fixture.removed).not.toContain(LOCK);
    expect(fixture.files.has(`${LOCK}.reclaim`)).toBe(false);
  });

  it("keeps an unreadable reclaim lock and does not delete the stale main lock", async () => {
    const reclaim = `${LOCK}.reclaim`;
    const fixture = lockIo(reclaim);
    fixture.files.set(LOCK, JSON.stringify({ pid: 99 }));
    fixture.files.set(reclaim, JSON.stringify({ pid: LIVE }));
    expect(await acquireLockFrom(fixture.io, fixture.host, ROOT, { quiet: true })).toBe(false);
    expect(fixture.removed).not.toContain(LOCK);
    expect(fixture.removed).not.toContain(reclaim);
    expect(JSON.parse(fixture.files.get(reclaim)!).pid).toBe(LIVE);
  });

  it("still reclaims a positively dead owner, then releases only its own lock", async () => {
    const fixture = lockIo();
    fixture.files.set(LOCK, JSON.stringify({ pid: 99 }));
    expect(await acquireLockFrom(fixture.io, fixture.host, ROOT, { quiet: true })).toBe(true);
    expect(JSON.parse(fixture.files.get(LOCK)!).pid).toBe(SELF);
    await releaseLockFrom(fixture.io, fixture.host, ROOT);
    expect(fixture.files.has(LOCK)).toBe(false);
    expect(fixture.removed).toContain(LOCK);
  });

  it("keeps the ordinary absent-lock acquisition and foreign-owner release guard", async () => {
    const fixture = lockIo();
    expect(await acquireLockFrom(fixture.io, fixture.host, ROOT, { quiet: true })).toBe(true);
    fixture.files.set(LOCK, JSON.stringify({ pid: LIVE }));
    await releaseLockFrom(fixture.io, fixture.host, ROOT);
    expect(JSON.parse(fixture.files.get(LOCK)!).pid).toBe(LIVE);
  });
});
