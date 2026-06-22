/**
 * @file test/event-crash-recovery.test.ts
 * @description Audit fix (Problem A): a crash BETWEEN `appendLine` and
 * `sealHeadAnchor` leaves the log with ONE complete, valid, chained record the
 * head does NOT yet seal. This is NOT a torn line (it parses fine), so the
 * torn-tail repair did not cover it — and `prepareEventStoreForAppend` bricked
 * EVERY future mutation on the head-anchor mismatch. The fix: the head SEAL is the
 * commit point, so a single trailing record the head does not seal is UNCOMMITTED
 * — dropped (truncated) on the next write, exactly like a torn tail. The store
 * recovers and stays appendable.
 *
 * Bound + tamper safety: under the project lock a single append adds AT MOST one
 * record before sealing, so recovery is bounded to ONE record ahead. The dropped
 * record is the UNcommitted (un-sealed) tail — a forged un-sealed trailing record
 * is removed, never accepted. Two-ahead and genuine tamper still reject with the
 * file BYTE-IDENTICAL (the round-3 invariant).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EVENTS_FILE, EVENTS_HEAD_FILE } from "../src/utils/constants.js";
import { appendEvent } from "../src/events/store.js";
import { readEventsStrict } from "../src/events/store-read.js";
import { EventStoreChainError } from "../src/events/types.js";
import {
  eventInput,
  seedEvents,
  appendUnsealedRecord,
  expectSwapTamperRejectedByteIdentical,
  expectCleanAppendSucceeds,
  makeEventTmpRoot,
  removeEventTmpRoot,
} from "./fixtures/event-store-probe.js";

describe("crash recovery — one record ahead of the head anchor", () => {
  let root = "";
  beforeEach(async () => { root = await makeEventTmpRoot("evt-crash-"); });
  afterEach(async () => { await removeEventTmpRoot(root); });
  const storePath = (): string => path.join(root, EVENTS_FILE);

  it("recovers a one-ahead store: drops the unsealed record, appends the new one cleanly", async () => {
    await seedEvents(root, ["a", "b"]); // head sealed at record 2
    const orphan = await appendUnsealedRecord(root, "crash"); // log is 3, head seals 2
    const rec = await appendEvent(root, eventInput("c"));
    const events = await readEventsStrict(root); // chain + head verify
    expect(events.map((e) => e.id)).not.toContain(orphan); // uncommitted record dropped
    expect(events.at(-1)?.id).toBe(rec.id);
  });

  it("recovers a FIRST-append crash: a lone record with NO head file appends fresh", async () => {
    const [header] = await seedEvents(root, ["seed"]); // establish header line
    await writeFile(storePath(), header + "\n"); // header-only (empty log)
    await rm(path.join(root, EVENTS_HEAD_FILE), { force: true }); // first append never sealed
    const orphan = await appendUnsealedRecord(root, "first"); // single genesis-chained record
    const rec = await appendEvent(root, eventInput("real"));
    const events = await readEventsStrict(root);
    expect(events.map((e) => e.id)).toEqual([rec.id]); // orphan dropped, fresh append
    expect(orphan).not.toBe(rec.id);
  });

  it("does NOT recover TWO unsealed records (not a single-crash state) — byte-identical", async () => {
    await seedEvents(root, ["a"]); // head sealed at record 1
    await appendUnsealedRecord(root, "x1");
    await appendUnsealedRecord(root, "x2"); // log is 3, head seals 1 (two ahead)
    const before = await readFile(storePath(), "utf8");
    await expect(appendEvent(root, eventInput("c"))).rejects.toBeInstanceOf(EventStoreChainError);
    expect(await readFile(storePath(), "utf8")).toBe(before);
  });

  it("a TAMPERED (reordered) + TORN chain still rejects byte-identical (round-3 invariant)", async () => {
    await expectSwapTamperRejectedByteIdentical(root, eventInput("d"), true);
  });

  it("a normal append still works after recovery (regression)", async () => {
    await expectCleanAppendSucceeds(root, ["a", "b"]);
  });
});
