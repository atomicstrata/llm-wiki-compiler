/**
 * @file test/history/events.test.ts
 * @description The segmented event log of an active `local-indexed` project
 * on real disk, reached through the incumbent event APIs: an imported legacy
 * log reads back identically and stays byte-identical; appends chain on,
 * reseal the head anchor and touch a bounded number of segments whatever the
 * history size; a one-behind anchor is resealed and a tampered one refuses;
 * a changed legacy backup refuses writes and is reported; operation-bound
 * events are found through the binding index; pages normalize their limits;
 * full verification is read-only and bounded in its diagnostics.
 */

import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { buildEventRecord } from "../../src/events/event-build.js";
import { eventPrevHash } from "../../src/events/event-digest.js";
import { appendOperationEventLocked } from "../../src/events/operation-events.js";
import { appendEvent, appendEventLocked } from "../../src/events/store.js";
import { readEvents, readEventsStrict } from "../../src/events/store-read.js";
import { eventHeaderLine, serializeEventRecord } from "../../src/events/store-record.js";
import { readEventsPage, verifyEventHistory } from "../../src/history/events-read.js";
import { newCounters, observeIo } from "../../src/segments/counters.js";
import { EVENTS_FILE, EVENTS_HEAD_FILE } from "../../src/utils/constants.js";
import { activateIndexed } from "../catalog/helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-events-seg-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const INPUT = { type: "connector-fetch" as const, origin: "test", payload: { n: 0 }, at: "2026-10-26T00:00:00.000Z" };
const BINDING = { bundleId: "bnd_01ARZ3NDEKTSV4RRFFQ69G5FAV", runId: "opr_01ARZ3NDEKTSV4RRFFQ69G5FAV", mutationId: `opm_${"a".repeat(64)}` };

/** Write a valid incumbent single-file log of `count` chained events, and its head anchor. */
async function writeLegacyLog(count: number): Promise<void> {
  let prev = "genesis";
  const lines = [eventHeaderLine()];
  for (let at = 0; at < count; at += 1) {
    const { checksum: _c, ...record } = buildEventRecord({ ...INPUT, payload: { n: at } }, prev);
    lines.push(serializeEventRecord(record));
    prev = eventPrevHash(record);
  }
  await mkdir(path.join(root, "wiki", "graph"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, EVENTS_FILE), lines.join(""));
  if (count > 0) await writeFile(path.join(root, EVENTS_HEAD_FILE), prev);
}

describe("import and append", () => {
  it("reads an imported log back identically, appends on its chain, and leaves the legacy file byte-identical", async () => {
    await writeLegacyLog(30);
    const legacy = await readEventsStrict(root);
    const before = await readFile(path.join(root, EVENTS_FILE));
    await activateIndexed(root);
    expect((await readEvents(root)).events).toEqual(legacy);
    const appended = await appendEvent(root, { ...INPUT, payload: { n: 30 } });
    expect(appended.prevHash).toBe(eventPrevHash(legacy.at(-1)!));
    const after = await readEventsStrict(root);
    expect([after.length, after.at(-1)!.id]).toEqual([31, appended.id]);
    expect((await readFile(path.join(root, EVENTS_HEAD_FILE), "utf8")).trim()).toBe(eventPrevHash(appended));
    expect(await readFile(path.join(root, EVENTS_FILE))).toEqual(before);
    expect(await verifyEventHistory(root)).toMatchObject({ ok: true, records: 31, problemCount: 0 });
  });

  it("touches the same bounded segments for an append at 100 and at 1600 events of history", async () => {
    const measure = async (count: number) => {
      await writeLegacyLog(count);
      await activateIndexed(root);
      const counters = newCounters();
      await observeIo(counters, () => appendEvent(root, INPUT));
      return counters;
    };
    const small = await measure(100);
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(path.join(tmpdir(), "llmwiki-events-seg-"));
    const large = await measure(1600);
    // The tail check reads the last two records; the commit writes one record segment and the manifest.
    expect(large.blocksRead).toBeLessThanOrEqual(small.blocksRead + 2);
    expect(large.rowsDecoded).toBeLessThan(1600);
    expect(large.manifestsPublished).toBe(1);
  });
});

describe("the head anchor and the legacy backup", () => {
  it("reseals a one-behind anchor, refuses a tampered one, and refuses writes after the backup changed", async () => {
    await writeLegacyLog(3);
    await activateIndexed(root);
    const first = await appendEventLocked(root, INPUT);
    await writeFile(path.join(root, EVENTS_HEAD_FILE), first.prevHash);
    const second = await appendEventLocked(root, INPUT);
    expect(second.prevHash).toBe(eventPrevHash(first));
    await writeFile(path.join(root, EVENTS_HEAD_FILE), "f".repeat(64));
    await expect(appendEventLocked(root, INPUT)).rejects.toThrow("head anchor does not match");
    await writeFile(path.join(root, EVENTS_HEAD_FILE), eventPrevHash(second));
    await writeFile(path.join(root, EVENTS_FILE), `${await readFile(path.join(root, EVENTS_FILE), "utf8")}\n`);
    await expect(appendEventLocked(root, INPUT)).rejects.toThrow("changed after it was imported");
    expect((await readEvents(root)).problems.some((problem) => problem.includes("changed after it was imported"))).toBe(true);
    expect(await verifyEventHistory(root)).toMatchObject({ ok: false, problemCount: 1 });
  });
});

describe("bound events and pages", () => {
  it("finds a bound event through the binding index and replays the same operation event without a write", async () => {
    await writeLegacyLog(5);
    await activateIndexed(root);
    const created = await appendOperationEventLocked(root, INPUT, BINDING);
    const counters = newCounters();
    const replay = await observeIo(counters, () => appendOperationEventLocked(root, INPUT, BINDING));
    expect([created.status, replay.status]).toEqual(["created", "same"]);
    expect(counters.manifestsPublished).toBe(0);
    const page = await readEventsPage(root, 2, Number.NaN);
    expect(page.events.map((event) => event.payload)).toEqual([{ n: 3 }, { n: 4 }, INPUT.payload]);
  });
});
