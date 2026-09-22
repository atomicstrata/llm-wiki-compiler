/**
 * @file test/lock-owner-liveness-classification.test.ts
 * @description The owner-liveness classification — two positive observations
 * and two ways of not being able to make one — and the proof that
 * deriving `isOwnerStale` from it preserves the pre-collapse behaviour BRANCH BY
 * BRANCH.
 *
 * `isOwnerStale` used to compute the evidence inline and return a boolean. It now
 * returns `classifyOwnerLiveness(owner) === "stale"`. That is only safe if every
 * branch of the old function maps to the same boolean, so each case below pins
 * BOTH the new classification AND the boolean the pre-collapse implementation
 * returned for that exact owner — quoted per case from the parent commit rather
 * than re-derived from the code under test.
 *
 * THE COLLAPSE IS DELIBERATELY LOSSY IN ONE DIRECTION. `live` and the two
 * unobservable arms all mean "do not reclaim", so no boolean caller
 * can distinguish them; a mutation swapping those two labels is EXPECTED to leave
 * the lock suites green. Any mutation that moves an arm ACROSS the stale boundary
 * must go red. Both halves are asserted here, because a proof that only predicts
 * red results cannot tell a faithful collapse from an over-eager one.
 */

import { describe, it, expect, vi } from "vitest";
import {
  classifyOwnerLiveness, isOwnerStale, isUnobservableLiveness, readProcessStartTime,
} from "../src/utils/lock-owner.js";
import type { LockOwner, OwnerLiveness } from "../src/utils/lock-owner.js";

/** A pid no host assigns, so the signal probe reports it GONE. */
const DEAD_PID = 999999;

/** A start time no live process can have, so it can only be a reused pid. */
/**
 * An identity in the CURRENT format that no live process can have.
 *
 * It must be versioned. A rendered date string is now classified UNRECOGNISED —
 * incomparable, therefore unobservable, therefore not stale — so using one to
 * mean "a start time that differs" would assert that an identity this build
 * cannot read proves the process is gone, which is precisely what the migration
 * guard refuses.
 */
const IMPOSSIBLE_START_TIME = "unix:1";

/**
 * PID 1 — live on every POSIX host and owned by root, so a non-root operator
 * observes it as EPERM (alive, foreign). Matches the instrument
 * `lock-pid-reuse.test.ts` already uses, deliberately: a spawned-then-killed pid
 * would be the ESRCH case, which is a different arm.
 */
const FOREIGN_LIVE_PID = 1;

/** True only when this process genuinely cannot signal the foreign pid. */
function foreignPidIsUnsignalable(): boolean {
  try {
    process.kill(FOREIGN_LIVE_PID, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Assert one arm: the classification, and the boolean the pre-collapse
 * implementation returned for this owner.
 */
function expectArm(owner: LockOwner, liveness: OwnerLiveness, preCollapseStale: boolean): void {
  expect(classifyOwnerLiveness(owner)).toBe(liveness);
  expect(isOwnerStale(owner)).toBe(preCollapseStale);
}

/**
 * Run `use` against a FRESH lock-owner module whose `ps` probe always fails, so
 * `readProcessStartTime` returns null for every pid — the only way to reach the
 * "alive but unidentifiable NOW" arm on a host where `ps` works.
 *
 * The module is re-imported rather than mutated because the self start time is
 * cached at module scope: an already-populated cache would keep the self arm on
 * the readable path and the case would pass while testing the wrong branch.
 */
async function withUnreadableStartTimes(
  use: (module: typeof import("../src/utils/lock-owner.js")) => void | Promise<void>,
): Promise<void> {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: () => { throw new Error("ps unavailable"); },
  }));
  try {
    await use(await import("../src/utils/lock-owner.js"));
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
}

describe("classifyOwnerLiveness — per-branch behaviour identity", () => {
  it("classifies a GONE pid as stale, exactly as the boolean did", () => {
    // Pre-collapse: `if (!isProcessAlive(owner.pid)) return true;`
    expectArm({ pid: DEAD_PID }, "stale", true);
    expectArm({ pid: DEAD_PID, startTime: IMPOSSIBLE_START_TIME }, "stale", true);
  });

  it("classifies a live pid whose recorded start time DIFFERS as stale", () => {
    // Pre-collapse self arm: `return current !== null && current !== owner.startTime;`
    // — the PID-reuse wedge, and the only arm on a live pid that reclaims.
    expectArm({ pid: process.pid, startTime: IMPOSSIBLE_START_TIME }, "stale", true);
  });

  it("classifies a live pid whose recorded start time MATCHES as live", () => {
    const startTime = readProcessStartTime(process.pid);
    expect(startTime).not.toBeNull();
    // Pre-collapse: same arm, `current === owner.startTime` → false.
    expectArm({ pid: process.pid, startTime: startTime! }, "live", false);
  });

  it("classifies a live FOREIGN pid by its start time, both ways", () => {
    // ANTI-VACUITY: running the suite as root makes pid 1 signalable and this
    // case would exercise the self path instead of the foreign one.
    expect(foreignPidIsUnsignalable()).toBe(true);
    const startTime = readProcessStartTime(FOREIGN_LIVE_PID);
    expect(startTime).not.toBeNull();
    // Pre-collapse foreign arm: `return current !== owner.startTime;`
    expectArm({ pid: FOREIGN_LIVE_PID, startTime: startTime! }, "live", false);
    expectArm({ pid: FOREIGN_LIVE_PID, startTime: IMPOSSIBLE_START_TIME }, "stale", true);
  });

  it("classifies a record that stored NO start time as PERMANENTLY unobservable", () => {
    // Pre-collapse: `if (owner.startTime === undefined) return false;` — the same
    // boolean, but the reason is not that the holder was confirmed. Nothing was
    // confirmed: the record never stored the evidence, so a reused pid here is
    // indistinguishable from a genuine holder and always will be.
    expectArm({ pid: process.pid }, "unobservable-unrecorded", false);
  });

  it("classifies a live pid whose start time cannot be read NOW as unobservable", async () => {
    await withUnreadableStartTimes((module) => {
      // PRECONDITION PINNED: without this the case could pass on a host where the
      // probe succeeded and the arm was never reached.
      expect(module.readProcessStartTime(process.pid)).toBeNull();
      // Pre-collapse: `if (current === null) return false;` on both the self and
      // the foreign leg — "unreadable → trust the recorded identity".
      expect(module.classifyOwnerLiveness({ pid: process.pid, startTime: IMPOSSIBLE_START_TIME }))
        .toBe("unobservable-unreadable");
      expect(module.isOwnerStale({ pid: process.pid, startTime: IMPOSSIBLE_START_TIME })).toBe(false);
    });
  });

  it("classifies an unreadable FOREIGN pid as unobservable too", async () => {
    expect(foreignPidIsUnsignalable()).toBe(true);
    await withUnreadableStartTimes((module) => {
      expect(module.readProcessStartTime(FOREIGN_LIVE_PID)).toBeNull();
      // The recorded start time is one that cannot be real, so a readable probe
      // would have said `stale`. It reads `unobservable` only because the
      // evidence is missing — which is what makes this the arm and not the other.
      expect(module.classifyOwnerLiveness({ pid: FOREIGN_LIVE_PID, startTime: IMPOSSIBLE_START_TIME }))
        .toBe("unobservable-unreadable");
      expect(module.isOwnerStale({ pid: FOREIGN_LIVE_PID, startTime: IMPOSSIBLE_START_TIME })).toBe(false);
    });
  });
});

describe("the stale collapse — what the boolean keeps and what it discards", () => {
  it("reclaims on a stale OBSERVATION and on nothing else", () => {
    // The collapse rule itself, stated once over every arm this file constructs.
    // `unobservable` sits on the same side as `live` deliberately: reclaiming a
    // lock we merely cannot identify would steal it from a live holder, and the
    // module's own trade is that wedging is visible while corruption is not.
    const owners: LockOwner[] = [
      { pid: DEAD_PID },
      { pid: process.pid, startTime: IMPOSSIBLE_START_TIME },
      { pid: process.pid, startTime: readProcessStartTime(process.pid)! },
      { pid: process.pid },
    ];
    for (const owner of owners) {
      expect(isOwnerStale(owner)).toBe(classifyOwnerLiveness(owner) === "stale");
    }
  });

  it("tells the two unobservable arms apart, because the remedies differ", async () => {
    // BOTH mean "cannot tell", and a reader that merged them would tell an
    // operator to retry a question that has no answer. The unrecorded arm is
    // permanent for that record — no read recovers what the write never stored —
    // while the unreadable one may answer from another host or a later moment.
    expect(classifyOwnerLiveness({ pid: process.pid })).toBe("unobservable-unrecorded");
    await withUnreadableStartTimes((module) => {
      expect(module.classifyOwnerLiveness({ pid: process.pid, startTime: IMPOSSIBLE_START_TIME }))
        .toBe("unobservable-unreadable");
    });
    // Both are still the same answer to the reclamation question, which is the
    // property the collapse depends on.
    expect(isUnobservableLiveness("unobservable-unrecorded")).toBe(true);
    expect(isUnobservableLiveness("unobservable-unreadable")).toBe(true);
    expect(isUnobservableLiveness("live")).toBe(false);
    expect(isUnobservableLiveness("stale")).toBe(false);
  });

  it("gives an operator-facing reader a distinction the boolean cannot carry", () => {
    // Both are "do not reclaim", and that is exactly why the boolean cannot be
    // the thing a report is built on: one says the holder is running, the other
    // says nobody can tell. Only the first justifies waiting for it.
    const confirmed: LockOwner = { pid: process.pid, startTime: readProcessStartTime(process.pid)! };
    const unidentifiable: LockOwner = { pid: process.pid };
    expect(isOwnerStale(confirmed)).toBe(isOwnerStale(unidentifiable));
    expect(classifyOwnerLiveness(confirmed)).not.toBe(classifyOwnerLiveness(unidentifiable));
  });
});
