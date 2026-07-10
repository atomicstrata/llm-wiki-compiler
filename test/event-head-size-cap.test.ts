/**
 * @file test/event-head-size-cap.test.ts
 * @description TDD tests for the events.head anchor read-side size cap (Fix 1).
 *
 * `readHeadAnchor` opens the `.llmwiki/events.head` file with O_NOFOLLOW (good)
 * but previously had NO size cap before the full-file read. A bloated head file
 * is effectively corrupt (a valid sealed digest is ~64 hex chars). This cap closes
 * the DoS/memory-exhaustion gap.
 *
 * Covers:
 *   - An oversized `.llmwiki/events.head` → `readEvents` fails closed with
 *     `EventStoreCorruptError` (bloated = effectively corrupt) — does NOT read it all.
 *   - A normal small head still works: emit an event, read it back (regression).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EVENTS_HEAD_FILE, MAX_EVENT_HEAD_BYTES } from "../src/utils/constants.js";
import { appendEvent } from "../src/events/store.js";
import { readEvents } from "../src/events/store-read.js";
import { EventStoreCorruptError } from "../src/events/types.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "evt-head-cap-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const headPath = (): string => path.join(root, EVENTS_HEAD_FILE);

describe("events.head size cap", () => {
  it("fails closed with EventStoreCorruptError when the head file exceeds the cap", async () => {
    // Append a real event so wiki/graph/events.jsonl exists with a valid header.
    // The head anchor is what we're bloating — the store itself is valid.
    await appendEvent(root, { type: "relation-create", origin: "sdk", payload: {}, at: "2024-01-01T00:00:00Z" });
    // Overwrite the head with a value far above the cap for a 64-byte digest.
    await writeFile(headPath(), "x".repeat(MAX_EVENT_HEAD_BYTES * 12), "utf8");
    await expect(readEvents(root)).rejects.toBeInstanceOf(EventStoreCorruptError);
  });

  it("normal small head still works: emit an event and read it back (regression)", async () => {
    await appendEvent(root, { type: "relation-create", origin: "sdk", payload: { key: "v" }, at: "2024-01-01T00:00:00Z" });
    const { events, problems } = await readEvents(root);
    expect(events).toHaveLength(1);
    expect(problems).toEqual([]);
    expect(events[0].id).toMatch(/^evt_/);
  });

  it("fails closed when the head file is exactly at the cap + 1 byte", async () => {
    // Plant a valid store (one appended event), then overwrite the head with cap+1 bytes.
    await appendEvent(root, { type: "relation-create", origin: "sdk", payload: {}, at: "2024-01-01T00:00:00Z" });
    // One byte over the cap must fail closed (boundary stays coupled to the constant).
    await writeFile(headPath(), "a".repeat(MAX_EVENT_HEAD_BYTES + 1), "utf8");
    await expect(readEvents(root)).rejects.toBeInstanceOf(EventStoreCorruptError);
  });
});
