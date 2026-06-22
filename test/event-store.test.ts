/**
 * @file test/event-store.test.ts
 * @description Tests for the append-only, hash-chained EVENT store (CLP 4b PR1).
 *
 * Covers: append→readback with an `evt_` id; the first record's prevHash is
 * GENESIS and the chain verifies; two events chain (record[1].prevHash ===
 * digest(record[0])); the sealed head anchor matches the last event; an interior
 * tamper / reorder breaks the chain (surfaced as a problem, not thrown); a
 * truncation is caught by the head anchor; a torn trailing line is
 * tolerated+reported; a symlinked leaf and a too-new schemaVersion fail closed;
 * and a DEFAULT project reads empty.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, appendFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EVENTS_FILE, EVENTS_HEAD_FILE } from "../src/utils/constants.js";
import { appendEvent, recordEvent } from "../src/events/store.js";
import { readEvents, readEventsStrict, verifyEventChain, verifyHeadAnchor } from "../src/events/store-read.js";
import { eventPrevHash } from "../src/events/event-digest.js";
import {
  EventStoreTooNewError,
  EventStoreSymlinkError,
  EventStoreCorruptError,
  EventStoreChainError,
  GENESIS_PREV_HASH,
} from "../src/events/types.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "evt-store-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const storePath = (): string => path.join(root, EVENTS_FILE);
const input = (n: string) => ({ type: "relation-create" as const, origin: "sdk", payload: { n }, at: "2024-01-01T00:00:00Z" });

describe("append / readback + chain", () => {
  it("persists an evt_ event whose first prevHash is GENESIS and chain verifies", async () => {
    const rec = await appendEvent(root, input("a"));
    expect(rec.id).toMatch(/^evt_/);
    const { events, problems } = await readEvents(root);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].prevHash).toBe(GENESIS_PREV_HASH);
    expect(verifyEventChain(events).ok).toBe(true);
  });

  it("chains two events: record[1].prevHash === digest(record[0])", async () => {
    await appendEvent(root, input("a"));
    await appendEvent(root, input("b"));
    const { events } = await readEvents(root);
    expect(events).toHaveLength(2);
    expect(events[1].prevHash).toBe(eventPrevHash(events[0]));
    expect(verifyEventChain(events).ok).toBe(true);
  });

  it("seals a head anchor matching the last event's digest", async () => {
    await appendEvent(root, input("a"));
    await appendEvent(root, input("b"));
    const { events } = await readEvents(root);
    const anchor = (await readFile(path.join(root, EVENTS_HEAD_FILE), "utf8")).trim();
    expect(anchor).toBe(eventPrevHash(events[1]));
    expect((await verifyHeadAnchor(root, events)).ok).toBe(true);
  });

  it("recordEvent({locked:false}) appends like appendEvent", async () => {
    const rec = await recordEvent(root, input("a"));
    const { events } = await readEvents(root);
    expect(events).toMatchObject([{ id: rec.id }]);
  });
});

describe("tamper / reorder / truncate detection", () => {
  it("surfaces a chain problem when two records are reordered (checksums intact)", async () => {
    await appendEvent(root, input("a"));
    await appendEvent(root, input("b"));
    await appendEvent(root, input("c"));
    const lines = (await readFile(storePath(), "utf8")).split("\n").filter(Boolean);
    const [header, r1, r2, r3] = lines; // swap r1<->r2: each record's checksum still valid
    await writeFile(storePath(), [header, r2, r1, r3].join("\n") + "\n");
    const { events, problems } = await readEvents(root);
    expect(verifyEventChain(events).ok).toBe(false);
    expect(problems.some((p) => /chain link broken/.test(p))).toBe(true);
    await expect(readEventsStrict(root)).rejects.toBeInstanceOf(EventStoreChainError);
  });

  it("fails closed when an interior event's payload is edited (checksum break)", async () => {
    await appendEvent(root, input("a"));
    await appendEvent(root, input("b"));
    const raw = await readFile(storePath(), "utf8");
    await writeFile(storePath(), raw.replace('"n":"a"', '"n":"TAMPERED"'));
    await expect(readEvents(root)).rejects.toBeInstanceOf(EventStoreCorruptError);
  });

  it("detects a truncated log (last record dropped) via the head anchor", async () => {
    await appendEvent(root, input("a"));
    await appendEvent(root, input("b"));
    const lines = (await readFile(storePath(), "utf8")).split("\n").filter(Boolean);
    await writeFile(storePath(), lines.slice(0, -1).join("\n") + "\n"); // drop last record
    const { events, problems } = await readEvents(root);
    expect((await verifyHeadAnchor(root, events)).ok).toBe(false);
    expect(problems.some((p) => /head anchor/.test(p))).toBe(true);
  });
});

describe("durability: torn / too-new / symlink / default", () => {
  it("tolerates and reports a torn trailing line", async () => {
    await appendEvent(root, input("a"));
    await appendFile(storePath(), '{"id":"evt_torn","type":"rel');
    const { events, problems } = await readEvents(root);
    expect(events).toHaveLength(1);
    expect(problems.some((p) => /torn trailing line/.test(p))).toBe(true);
  });

  it("fails closed when schemaVersion exceeds the known version", async () => {
    await mkdir(path.dirname(storePath()), { recursive: true });
    await writeFile(storePath(), '{"kind":"event-store-header","schemaVersion":99}\n');
    await expect(readEvents(root)).rejects.toThrow(EventStoreTooNewError);
  });

  it("fails closed when the events leaf is a symlink", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "evt-escape-"));
    await mkdir(path.dirname(storePath()), { recursive: true });
    await writeFile(path.join(outside, "leak.jsonl"), "x");
    await symlink(path.join(outside, "leak.jsonl"), storePath());
    await expect(readEvents(root)).rejects.toBeInstanceOf(EventStoreSymlinkError);
    await rm(outside, { recursive: true, force: true });
  });

  it("reads empty for a DEFAULT project with no wiki/graph", async () => {
    await expect(readEvents(root)).resolves.toEqual({ events: [], problems: [] });
  });
});
