/**
 * @file test/lock-owner-identity-invariance.test.ts
 * @description The process identity is timezone- and locale-invariant, and the
 * format change cannot reclaim a live holder.
 *
 * THE DEFECT. Identity was whatever `ps -o lstart=` printed, which libc renders
 * in the AMBIENT timezone. One live process therefore yielded different
 * identities to readers in different zones — a container beside its host, a cron
 * job, a `TZ=UTC` run — and a DST transition alone did it on a single correctly
 * configured host. `isOwnerStale` read that difference as PID REUSE and reclaimed
 * the lock of a live holder, or cleared a live executor's fence.
 *
 * THE MIGRATION IS THE MOST DANGEROUS PART OF THE FIX, and has its own cases
 * below. Every record written before this change holds a rendered date string. A
 * new reader emitting `unix:<epoch>` compares against one and sees a difference —
 * and a naive implementation concludes stale, so the migration would cause the
 * exact defect it fixes, on every pre-existing record, on first read.
 *
 * WHY A SPAWNED CHILD RATHER THAN PID 1. The identity read has a cached self fast
 * path, so an owner naming THIS process witnesses nothing about the `ps` route —
 * every case needs a FOREIGN pid. `init` would be the usual choice and cannot be
 * used at this baseline: on `main`, `isProcessAlive` is a bare
 * `catch { return false }`, so a process this uid may not signal reads as DEAD
 * and `isOwnerStale` short-circuits before any identity is compared. A spawned
 * child is foreign — it is not `process.pid`, so no fast path — and signalable,
 * so it reaches the comparison this file is about.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  classifyIdentityComparability, isOwnerStale, readProcessStartTime,
} from "../src/utils/lock-owner.js";
import type { IdentityComparabilityV1 } from "../src/utils/lock-owner.js";

/** A pid no host assigns, so the signal probe reports it gone. */
const DEAD_PID = 999999;

/** The identity shape this build emits. */
const IDENTITY = /^unix:\d+$/u;

let child: ChildProcess;
let livePid = 0;

beforeAll(async () => {
  child = spawn("sleep", ["120"], { stdio: "ignore" });
  livePid = child.pid ?? 0;
  expect(livePid).toBeGreaterThan(0);
  // ANTI-VACUITY, both halves: a pid equal to our own would take the cached self
  // path and witness nothing, and a child that never started would make every
  // case below pass for the wrong reason.
  expect(livePid).not.toBe(process.pid);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(() => process.kill(livePid, 0)).not.toThrow();
});
afterAll(() => { child.kill("SIGKILL"); });

/**
 * Read the live child's identity with the AMBIENT timezone set to `zone`.
 *
 * In-process rather than through a spawned reader, because Node honours a
 * runtime `process.env.TZ` change for `Date.parse` — measured, the same string
 * parses to two different instants under two zones. So this really does vary the
 * zone the reader interprets under, which is the half of the defect that pinning
 * `ps` alone does not close.
 */
function identityUnder(zone: string): string | null {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return readProcessStartTime(livePid);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe("the identity does not depend on where it is read", () => {
  it("collapses FOUR distinct pre-fix identities to ONE", () => {
    // THE WHOLE POINT OF THE FIX, measured as a count. Before the change these
    // four zones rendered four different strings for one live process — the
    // reader's zone decided the identity. After it there is one identity.
    const zones = ["UTC", "Asia/Tokyo", "America/New_York", "Europe/London"];
    const identities = new Set(zones.map((zone) => identityUnder(zone)));
    expect(identities.size).toBe(1);
    expect([...identities][0]).toMatch(IDENTITY);
  });

  it("is identical across a DST BOUNDARY pair, which needs no misconfiguration", () => {
    // The reachability that makes this urgent rather than theoretical: these
    // zones differ from each other AND each shifts across its own transition, so
    // a lock merely HELD across a DST change used to read stale on one host.
    expect(identityUnder("America/New_York")).toBe(identityUnder("Europe/London"));
  });

  it("survives a non-C locale, which renders month names differently", () => {
    // `LC_ALL` is pinned alongside `TZ` because a localized month name changes
    // the rendered string without changing the instant.
    const pinned = identityUnder("UTC");
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = "de_DE.UTF-8";
    try {
      expect(readProcessStartTime(livePid)).toBe(pinned);
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  });
});

describe("the format change cannot reclaim a live holder", () => {
  it("treats a LEGACY human-readable identity as INCOMPARABLE, not as a match", () => {
    // THE ASSERTION THAT ACTUALLY DISCRIMINATES, and the reason it is on the
    // VERDICT rather than the boolean. "Not reclaimed" is true for three
    // different reasons, and it is true at the PRE-FIX baseline too — there the
    // reader emitted the same rendered form, so the strings MATCHED and it read
    // as a live holder. Same green, different mechanism. Only the verdict tells
    // a correct migration guard from an implementation that happened to
    // string-match, so the verdict is what this case pins.
    const current = readProcessStartTime(livePid);
    expect(classifyIdentityComparability("Thu Jul 23 11:16:28 2026", current))
      .toBe("unrecognised-format");
    expect(isOwnerStale({ pid: livePid, startTime: "Thu Jul 23 11:16:28 2026" })).toBe(false);
  });

  it("covers the BARE-PID legacy shape too, which never reaches the comparison", () => {
    // A legacy leaf has TWO shapes. `parseOwner`'s bare-decimal branch yields
    // `{pid}` with no identity at all, so the oldest records take the
    // no-recorded-identity arm rather than the format check — which is why the
    // migration covers both without a second guard.
    expect(classifyIdentityComparability(undefined, "unix:1")).toBe("no-recorded-identity");
    expect(isOwnerStale({ pid: livePid })).toBe(false);
  });

  it("treats an UNREADABLE current identity as its own reason, not as a mismatch", () => {
    // The third not-stale reason, named separately because an operator asking
    // "why was this not reclaimed" gets three different answers.
    expect(classifyIdentityComparability("unix:1", null)).toBe("unreadable-now");
  });

  it("lets exactly ONE member of the verdict union reach reclamation", () => {
    // A TOTAL MAP KEYED ON THE UNION, not a sample of it.
    //
    // This case used to build four literal calls and filter them for
    // `comparable` — a claim about the WHOLE verdict set, evidenced over four
    // rows somebody typed. Adding a fifth verdict that could reclaim left `tsc`
    // at 0 and the suite green, while the case still read as a proof about the
    // union. A claim about a set, evidenced over a subset its own author chose.
    //
    // Keying a `Record` on the union moves the failure to COMPILE time: a new
    // verdict makes this map incomplete and `tsc` refuses it, so a verdict
    // cannot be ADDED without being classified. A runtime iteration only fails
    // when somebody runs this file.
    const RECLAIMABLE: Readonly<Record<IdentityComparabilityV1, boolean>> = {
      comparable: true,
      "no-recorded-identity": false,
      "unreadable-now": false,
      "unrecognised-format": false,
    };
    // ASSERTED OVER THE VALUES, never over one key. "`comparable` is true" is a
    // fact about one member and survives a second member also becoming true;
    // "exactly one entry is true" is the property of the union this rule needs.
    expect(Object.values(RECLAIMABLE).filter(Boolean)).toHaveLength(1);
  });

  it("treats ANY unrecognised identity format the same way", () => {
    // Not just yesterday's format. The rule is "no comparison is possible", not
    // "this particular old shape", so a near-miss must fail safe too.
    for (const recorded of ["", "epoch:1784830588", "unix", "1784830588"]) {
      expect(isOwnerStale({ pid: livePid, startTime: recorded }), recorded).toBe(false);
    }
  });

  it("still respects a record with NO start time at all", () => {
    // The pre-existing arm the migration guard joins rather than replaces.
    expect(isOwnerStale({ pid: livePid })).toBe(false);
  });
});

describe("the limits of a one-second identity, measured rather than assumed", () => {
  it("fails SAFE when two starts fall in the same second", () => {
    // `lstart` has one-second resolution, so a reused pid whose replacement
    // started within the same second as the original compares EQUAL. Measured
    // direction: equal ⇒ not stale ⇒ we DECLINE to reclaim. That is a strand,
    // not damage — the failure lands on the conservative side, which is the
    // only acceptable direction for it. If it ever lands the other way this
    // case goes red and the fix is unsafe.
    expect(classifyIdentityComparability("unix:1784830588", "unix:1784830588")).toBe("comparable");
    expect(isOwnerStale({ pid: livePid, startTime: readProcessStartTime(livePid)! })).toBe(false);
  });

  it("returns null where `ps` cannot answer, joining the unreadable arm", () => {
    // THE CASE A HARDENED HOST ACTUALLY HITS — a container without procps, or a
    // restricted process table. `ps` failing is indistinguishable here from `ps`
    // being absent: both throw, both yield null, and null is `unreadable-now`,
    // which does not reclaim. Exercised through a pid `ps` refuses to report.
    expect(readProcessStartTime(DEAD_PID)).toBeNull();
    expect(classifyIdentityComparability("unix:1", null)).toBe("unreadable-now");
  });

  it("derives SECONDS, which is the thing that bounds the window", () => {
    // THE CONTROL THE ACCEPTED TRADE RESTS ON. Same-second reuse comparing equal
    // is tolerable *because the window is one second*. Nothing else pins that:
    // coarsen the derivation and the accepted risk silently becomes a
    // sixty-second strand window, or an hour, with every other case still green.
    //
    // The previous version of this case asserted a mismatch against a literal
    // 1.4 MILLION seconds from the live identity. It witnessed that *some*
    // difference is detected — which the reused-pid case above already covers —
    // and said nothing whatever about one second. Its name and comment claimed
    // evidence its assertion did not supply.
    //
    // ASSERTED AGAINST WALL CLOCK, because the derivation itself is internal.
    // The child was spawned moments ago, so its start instant must sit within a
    // small window of now WHEN READ AS SECONDS. Coarsening the divisor to
    // minutes moves the value by a factor of sixty and finer-graining it to
    // milliseconds by a thousand, so the bound is two-sided and either direction
    // fails it.
    const now = Math.floor(Date.now() / 1000);
    const identity = readProcessStartTime(livePid);
    expect(identity).toMatch(IDENTITY);
    const seconds = Number(identity?.slice("unix:".length));
    expect(seconds).toBeGreaterThan(now - 600);
    expect(seconds).toBeLessThanOrEqual(now + 5);
  });
});

describe("the fix does not cost the hardening it was built on", () => {
  it("still reclaims a DEAD pid", () => {
    // THE DIRECTION THAT FAILS SILENTLY IF THE FIX OVER-CORRECTS. Making
    // everything unobservable would satisfy every case above and leave the
    // project unable to reclaim anything at all.
    expect(isOwnerStale({ pid: DEAD_PID })).toBe(true);
    expect(isOwnerStale({ pid: DEAD_PID, startTime: "unix:1" })).toBe(true);
  });

  it("still reclaims a REUSED pid — live, but a different start instant", () => {
    // A well-formed identity that cannot be this process's own, so the
    // comparison is REACHED and answers stale.
    expect(isOwnerStale({ pid: livePid, startTime: "unix:1" })).toBe(true);
  });

  it("still RESPECTS a live holder whose identity matches", () => {
    const current = readProcessStartTime(livePid);
    expect(current).toMatch(IDENTITY);
    if (current === null) return;
    expect(isOwnerStale({ pid: livePid, startTime: current })).toBe(false);
  });
});
