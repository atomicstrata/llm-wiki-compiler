/**
 * @file test/event-append-fail-closed.test.ts
 * @description Audit FIX F1: the event-store APPEND must refuse to re-seal over a
 * tampered chain (no laundering), and a TRUNCATED-to-empty log (records gone but
 * the sealed head anchor still points at a real digest) must surface as a
 * head-anchor mismatch instead of reading as a healthy empty store.
 *
 * Probes:
 *   - drop / edit / reorder an existing event → the NEXT appendEvent THROWS
 *     (EventStoreChainError), so the tamper stays detectable (not laundered);
 *   - truncate the log to header-only while events.head still points at a digest →
 *     readEvents reports a head-anchor mismatch + readEventsStrict throws;
 *   - a fresh project (no log, no head) reads healthy empty;
 *   - a normal append on a healthy chain still works.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EVENTS_FILE, EVENTS_HEAD_FILE } from "../src/utils/constants.js";
import { appendEvent } from "../src/events/store.js";
import { readEvents, readEventsStrict } from "../src/events/store-read.js";
import { EventStoreChainError } from "../src/events/types.js";
import { eventInput, seedEvents, expectEmptyEventsProblem } from "./fixtures/event-store-probe.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "evt-failclosed-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const storePath = (): string => path.join(root, EVENTS_FILE);

describe("FIX F1 — append refuses on a tampered chain (no laundering)", () => {
  it("THROWS on the next append when an interior event is dropped", async () => {
    const [header, , r2, r3] = await seedEvents(root, ["a", "b", "c"]);
    await writeFile(storePath(), [header, r2, r3].join("\n") + "\n"); // drop r1
    await expect(appendEvent(root, eventInput("d"))).rejects.toBeInstanceOf(EventStoreChainError);
  });

  it("THROWS on the next append when two events are reordered", async () => {
    const [header, r1, r2, r3] = await seedEvents(root, ["a", "b", "c"]);
    await writeFile(storePath(), [header, r2, r1, r3].join("\n") + "\n"); // swap r1<->r2
    await expect(appendEvent(root, eventInput("d"))).rejects.toBeInstanceOf(EventStoreChainError);
    // The tamper is NOT laundered: the chain problem is still surfaced.
    const { problems } = await readEvents(root);
    expect(problems.some((p) => /chain link broken/.test(p))).toBe(true);
  });

  it("THROWS on the next append when the log is truncated to header-only", async () => {
    const [header] = await seedEvents(root, ["a", "b", "c"]);
    await writeFile(storePath(), header + "\n"); // head anchor still points at r3
    await expect(appendEvent(root, eventInput("d"))).rejects.toBeInstanceOf(EventStoreChainError);
  });
});

describe("FIX F1 — head-without-log truncation detection", () => {
  it("readEvents reports a head mismatch + readEventsStrict throws when truncated to empty", async () => {
    const [header] = await seedEvents(root, ["a", "b"]);
    await writeFile(storePath(), header + "\n"); // header-only; events.head still set
    await expectEmptyEventsProblem(root, /head anchor/);
  });

  it("a fresh project (no log, no head) reads healthy empty", async () => {
    await expect(readEvents(root)).resolves.toEqual({ events: [], problems: [] });
    await expect(readEventsStrict(root)).resolves.toEqual([]);
  });

  it("a normal append on a healthy chain still works", async () => {
    await appendEvent(root, eventInput("a"));
    const rec = await appendEvent(root, eventInput("b"));
    const { events, problems } = await readEvents(root);
    expect(problems).toEqual([]);
    expect(events.map((e) => e.id)).toContain(rec.id);
    const anchor = (await readFile(path.join(root, EVENTS_HEAD_FILE), "utf8")).trim();
    expect(anchor.length).toBeGreaterThan(0);
  });
});
