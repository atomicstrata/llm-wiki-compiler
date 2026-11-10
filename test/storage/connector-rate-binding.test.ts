/**
 * @file test/storage/connector-rate-binding.test.ts
 * @description The connector rate stamp over storage bindings. This file uses
 * `updateRateStampLockedFrom`, which exists only after the stamp was given
 * bindings, so it has NO before-edit run and is not part of
 * `connector-rate-legacy.test.ts`.
 *
 * M1 to M4 and M6 pass two in-memory objects: one capped read and one atomic
 * write, and nothing else. There is no project and no file. Every case asserts
 * the WHOLE recorded conversation, with the literal project-relative path, the
 * literal cap and the literal stamp text, and how many times the clock was
 * read. M5 is the positive control on real files with the two local-disk
 * bindings and literal stamp bytes; it does not compare the two forms.
 *
 * M6 records behaviour as it is, NOT as it ought to be: a stamp dated in the
 * future refuses every run until that moment has passed.
 *
 * The function under test takes NO lock and checks none: its caller must hold
 * the project mutation lock and owns the connector id. The doubles are test
 * doubles. They are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { updateRateStampLockedFrom } from "../../src/connectors/rate-limit.js";
import { diskLocalCappedReads } from "../../src/storage/disk-local-reads.js";
import { diskLocalRecords } from "../../src/storage/disk-local-records.js";
import type { CappedTextRead, LegacyLocalCappedReads } from "../../src/storage/legacy-local-reads.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const disk = useTempRoot();
const T = 1_800_000_000_000;
const STAMP = ".llmwiki/connectors/fixture.last-fetch.json";
const READ = ["read", STAMP, 512];
const REFUSED = { kind: "refused", reason: "connector minimum request interval has not elapsed" };
const UNAVAILABLE = { kind: "unavailable", reason: "connector rate state unavailable" };
const CORRUPT = { kind: "unavailable", reason: "connector rate state corrupt" };
const holding = (atMs: unknown): CappedTextRead => ({ kind: "ok", body: `${JSON.stringify({ atMs })}\n` });

/** One capped read answering `stamp` (or rejecting with it) and one write; every call is recorded in order. */
function memory(stamp: CappedTextRead | Error, writeError?: Error) {
  const calls: unknown[][] = [];
  const reads: LegacyLocalCappedReads = {
    readCappedText: async (relPath, maxBytes) => {
      calls.push(["read", relPath, maxBytes]);
      if (stamp instanceof Error) throw stamp;
      return stamp;
    },
  };
  const records = {
    writeAtomic: async (relPath: string, text: string): Promise<void> => {
      calls.push(["write", relPath, text]);
      if (writeError) throw writeError;
    },
  };
  return { calls, reads, records };
}

/** Run the stamp update for `fixture` with a 1,000 ms floor and a counted clock fixed at `atMs`. */
async function update(state: ReturnType<typeof memory>, atMs: number) {
  const clock = vi.fn(() => new Date(atMs));
  const settled = await updateRateStampLockedFrom(state.reads, state.records, "fixture", 1_000, clock)
    .then((result) => ({ result }), (error: Error) => ({ rejected: error.message }));
  return { ...settled, calls: state.calls, clockReads: clock.mock.calls.length };
}

describe("the connector rate stamp over storage bindings", () => {
  it("M1 writes the first stamp: one read of the literal path and cap, then one write of the literal text", async () => {
    expect(await update(memory({ kind: "absent" }), T)).toEqual({
      result: null, calls: [READ, ["write", STAMP, '{"atMs":1800000000000}\n']], clockReads: 1,
    });
  });

  it("M2 refuses one millisecond inside the interval with no write, and writes exactly at it", async () => {
    expect(await update(memory(holding(T)), T + 999)).toEqual({ result: REFUSED, calls: [READ], clockReads: 1 });
    expect(await update(memory(holding(T)), T + 1_000)).toEqual({
      result: null, calls: [READ, ["write", STAMP, '{"atMs":1800000001000}\n']], clockReads: 1,
    });
  });

  it("M3 fails closed on an unavailable or corrupt stamp: no write, and the clock is never read", async () => {
    expect(await update(memory({ kind: "unavailable" }), T)).toEqual({ result: UNAVAILABLE, calls: [READ], clockReads: 0 });
    const corrupt = [{ kind: "ok", body: "not json" }, holding(1.5), holding("1"), { kind: "ok", body: "{}" }] as const;
    for (const stamp of corrupt) {
      expect(await update(memory(stamp), T)).toEqual({ result: CORRUPT, calls: [READ], clockReads: 0 });
    }
  });

  it("M4 resolves a rejecting write as unavailable, and lets a rejecting read reject", async () => {
    const written = ["write", STAMP, '{"atMs":1800000000000}\n'];
    expect(await update(memory({ kind: "absent" }, new Error("disk full")), T)).toEqual({
      result: UNAVAILABLE, calls: [READ, written], clockReads: 1,
    });
    expect(await update(memory(new Error("read exploded")), T)).toEqual({ rejected: "read exploded", calls: [READ], clockReads: 0 });
  });

  it("M5 runs the same update on real files through the two local-disk bindings, under a lock the test holds", async () => {
    const stamp = (): Promise<string> => readFile(path.join(disk.dir, STAMP), "utf8");
    const onDisk = (atMs: number) =>
      updateRateStampLockedFrom(diskLocalCappedReads(disk.dir), diskLocalRecords(disk.dir), "fixture", 1_000, () => new Date(atMs));
    expect(await acquireLock(disk.dir, { quiet: true })).toBe(true);
    try {
      expect(await onDisk(T)).toBeNull();
      expect(await stamp()).toBe('{"atMs":1800000000000}\n');
      expect(await onDisk(T + 1)).toEqual(REFUSED);
      expect(await stamp()).toBe('{"atMs":1800000000000}\n');
    } finally {
      await releaseLock(disk.dir);
    }
  });

  it("M6 INCUMBENT, not endorsed: a stamp dated a minute in the future refuses now, with no write", async () => {
    expect(await update(memory(holding(T + 60_000)), T)).toEqual({ result: REFUSED, calls: [READ], clockReads: 1 });
  });
});
