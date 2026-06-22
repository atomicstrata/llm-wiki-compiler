/**
 * @file test/event-store-cap.test.ts
 * @description TDD tests for the event store WRITE-side size caps:
 * `MAX_EVENT_RECORD_BYTES` (per-record) and `MAX_EVENT_STORE_BYTES` (whole file).
 *
 * The store-size cap tests mock `MAX_EVENT_STORE_BYTES` to a small value so the
 * test can drive the store to/over the cap with real event records, without having
 * to write 64 MB to disk. The per-record tests use a large enough payload to push
 * the serialized record over `MAX_EVENT_RECORD_BYTES`.
 *
 * Probes:
 *   - An oversized single payload throws `EventStoreFullError` BEFORE writing
 *     (the store remains readable afterward).
 *   - Appending when the file is near capacity so the new record would cross the
 *     store-size cap throws `EventStoreFullError` and leaves the file unchanged.
 *   - A normal under-cap append still succeeds and chains correctly (regression).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EVENTS_FILE } from "../src/utils/constants.js";
import { MAX_EVENT_RECORD_BYTES } from "../src/utils/constants.js";
import { appendEvent } from "../src/events/store.js";
import { readEvents } from "../src/events/store-read.js";
import { EventStoreFullError } from "../src/events/types.js";

// Use a tiny store cap so the store-size tests stay fast (no 64 MB writes).
// NOTE: the literal 1024 is inlined in the mock factory because vi.mock is hoisted
// before variable declarations and cannot reference module-level const bindings.
vi.mock("../src/utils/constants.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/constants.js")>();
  return { ...actual, MAX_EVENT_STORE_BYTES: 1024 };
});

const SMALL_STORE_CAP = 1024;

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "evt-cap-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const storePath = (): string => path.join(root, EVENTS_FILE);

/** Build an event input whose payload string is exactly `payloadSize` bytes (UTF-8). */
function bigInput(payloadSize: number) {
  return {
    type: "relation-create" as const,
    origin: "sdk",
    payload: { data: "x".repeat(payloadSize) },
    at: "2024-01-01T00:00:00Z",
  };
}

describe("per-record size cap (MAX_EVENT_RECORD_BYTES)", () => {
  it("throws EventStoreFullError before writing when the serialized record is too large", async () => {
    // A payload large enough to push the full JSON record above the per-record cap.
    const input = bigInput(MAX_EVENT_RECORD_BYTES);
    await expect(appendEvent(root, input)).rejects.toBeInstanceOf(EventStoreFullError);
  });

  it("leaves the store readable (and unchanged) after an oversized-record rejection", async () => {
    // Append one valid event first so the store exists.
    await appendEvent(root, bigInput(10));
    const beforeRead = await readEvents(root);
    expect(beforeRead.events).toHaveLength(1);

    // Now try to append an oversized record.
    await expect(appendEvent(root, bigInput(MAX_EVENT_RECORD_BYTES))).rejects.toBeInstanceOf(EventStoreFullError);

    // The store must still be readable and still have exactly one event.
    const { events, problems } = await readEvents(root);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
  });
});

describe("store-size cap (MAX_EVENT_STORE_BYTES = tiny mock)", () => {
  it("throws EventStoreFullError when the projected append would reach/exceed the store cap", async () => {
    // Fill the store with events until the next one would cross the tiny cap.
    // Each event is ~200 bytes serialized; SMALL_STORE_CAP is 1024 bytes.
    // After a few events the store should be full enough for the next to fail.
    let threw = false;
    for (let i = 0; i < 20; i++) {
      try {
        await appendEvent(root, bigInput(10));
      } catch (err) {
        expect(err).toBeInstanceOf(EventStoreFullError);
        threw = true;
        break;
      }
    }
    expect(threw).toBe(true);
  });

  it("leaves the store readable after a store-full rejection", async () => {
    // Seed events until the store is full.
    let lastGoodCount = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await appendEvent(root, bigInput(10));
        lastGoodCount = i + 1;
      } catch {
        break;
      }
    }
    // At this point the store is full; the last append threw EventStoreFullError.
    // The store must still be readable with the pre-full count intact.
    const { events, problems } = await readEvents(root);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(lastGoodCount);
  });

  it("the file size does not grow after a store-full rejection", async () => {
    // Seed until first rejection.
    let sizeBefore = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await appendEvent(root, bigInput(10));
      } catch {
        // Capture the file size AT the point the first rejection happened.
        sizeBefore = (await stat(storePath())).size;
        break;
      }
    }
    // A second rejected attempt must not grow the file.
    await expect(appendEvent(root, bigInput(10))).rejects.toBeInstanceOf(EventStoreFullError);
    const sizeAfter = (await stat(storePath())).size;
    expect(sizeAfter).toBe(sizeBefore);
  });
});

describe("under-cap append (regression)", () => {
  it("succeeds and chains normally for small events within the cap", async () => {
    const r1 = await appendEvent(root, bigInput(10));
    const r2 = await appendEvent(root, bigInput(10));
    const { events, problems } = await readEvents(root);
    expect(problems).toEqual([]);
    // At least the first two must succeed (both fit in 1 KB with a few records).
    expect(events[0].id).toBe(r1.id);
    expect(events[1].id).toBe(r2.id);
  });
});
