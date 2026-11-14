/**
 * @file Deterministic regression for reclaiming a lock that was RELEASED, not abandoned.
 * @description The second double-ownership window behind the "flaky" broken
 * event chain in the concurrent relation-store test (the first, an empty lock
 * leaf mid-publication, is pinned by `lock-publication-race.test.ts`).
 *
 * The staleness check used to treat an ABSENT lock leaf as stale. Under
 * contention that is the common case, not the corrupt one: a contender's
 * publish fails because the holder has the lock, the holder releases, and the
 * contender's read then finds nothing. It took the reclaim lock, re-read the
 * still-absent name as stale, and unlinked whatever was at the name by the time
 * it got there. The reclaim lock serializes reclaimers only; a fresh acquirer
 * publishes onto a free name without it, so the leaf unlinked was a LIVE
 * holder's, and both processes went on to append.
 *
 * Three owners share one process here, told apart by their host's process id,
 * and every owner counts as alive. The contender's storage reads are tapped to
 * replay the exact interleaving: the holder releases just before the
 * contender's first read, and a fresh acquirer publishes just after its second.
 * Against the old staleness check both the contender and the fresh acquirer
 * win, on every run.
 */

import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { locationRealPath } from "../src/storage/disk-locations.js";
import { readPrivateLeafText } from "../src/storage/disk-private-leaves.js";
import { LOCK_FILE } from "../src/utils/constants.js";
import { acquireLockFrom, type LockHost, type LockIo } from "../src/utils/lock.js";
import { diskLockPublicationIo, hostScratchEntropy } from "../src/utils/lock-publication.js";
import { diskPrivateDirIo } from "../src/utils/private-dir.js";
import { tempRootTracker } from "./temp-roots.js";

const roots = tempRootTracker();
afterEach(() => roots.cleanup());

/** Distinct owner ids for the three parties; every one of them is treated as alive. */
const HOLDER = 1001;
const CONTENDER = 1002;
const FRESH_ACQUIRER = 1003;

/** The real on-disk lock I/O, with an optional tap around each capped leaf read. */
function diskIo(tapRead?: (leaf: string, read: () => ReturnType<LockIo["readLeafCapped"]>) => ReturnType<LockIo["readLeafCapped"]>): LockIo {
  const readLeafCapped = (leaf: string, maxBytes: number) => readPrivateLeafText(leaf, maxBytes);
  return {
    ...diskPrivateDirIo,
    ...diskLockPublicationIo,
    realPath: (location) => locationRealPath(location),
    readLeafCapped: tapRead ? (leaf, maxBytes) => tapRead(leaf, () => readLeafCapped(leaf, maxBytes)) : readLeafCapped,
  };
}

/** A host acting as owner `pid`, whose every recorded owner is a live process. */
function hostFor(pid: number): LockHost {
  const unused = (): never => { throw new Error("blocking acquisition is not exercised here"); };
  return {
    processId: () => pid,
    serializeOwner: (owner) => String(owner),
    isOwnerProcessStale: () => false,
    entropy: hostScratchEntropy,
    now: () => Date.now(),
    sleep: async () => {},
    admit: unused,
    park: unused,
    releaseParked: () => {},
    hasParked: () => false,
    status: () => {},
  };
}

/**
 * Replay the interleaving: the holder has the lock when the contender first
 * tries to publish, releases before the contender's first read of the lock
 * name, and a fresh acquirer publishes right after the contender's second read.
 */
async function raceContender(root: string): Promise<{ contenderWon: boolean; freshWon: boolean[] }> {
  const lockPath = path.join(root, LOCK_FILE);
  expect(await acquireLockFrom(diskIo(), hostFor(HOLDER), root)).toBe(true);
  const freshWon: boolean[] = [];
  let lockReads = 0;
  const contenderIo = diskIo(async (leaf, read) => {
    if (leaf !== lockPath) return read();
    lockReads++;
    if (lockReads === 1) await diskIo().removeLeaf(lockPath); // the holder releases
    const result = await read();
    if (lockReads === 2) freshWon.push(await acquireLockFrom(diskIo(), hostFor(FRESH_ACQUIRER), root));
    return result;
  });
  const contenderWon = await acquireLockFrom(contenderIo, hostFor(CONTENDER), root);
  return { contenderWon, freshWon };
}

describe("lock reclamation after a release", () => {
  it("never gives the lock to two acquirers when the holder releases mid-contention", async () => {
    const root = await roots.create("llmwiki-lock-released-", { real: true });

    const { contenderWon, freshWon } = await raceContender(root);

    const winners = [contenderWon, ...freshWon].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

});
