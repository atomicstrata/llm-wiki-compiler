/**
 * @file test/fixtures/event-store-probe.ts
 * @description Shared event-store test scaffolding for the FIX F1 fail-closed
 * tests: the standard event-input factory and a helper that appends N chained
 * events and returns the on-disk header + record lines (so a test can drop /
 * reorder / truncate them). Centralized so the probe boilerplate is not redrawn
 * per fail-closed test file.
 */

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { EVENTS_FILE } from "../../src/utils/constants.js";
import { appendEvent, type AppendEventInput } from "../../src/events/store.js";
import { readEvents, readEventsStrict } from "../../src/events/store-read.js";
import { EventStoreChainError } from "../../src/events/types.js";
import { serializeEventRecord } from "../../src/events/store-record.js";
import { eventPrevHash } from "../../src/events/event-digest.js";

/** A partial (newline-less) JSON fragment so the store's trailing line is torn. */
export const TORN_FRAGMENT = '{"id":"evt_torn","type":"rel';

/** Make a fresh temp project root for an event-store probe (caller cleans it up). */
export function makeEventTmpRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Remove a temp root made by {@link makeEventTmpRoot} (no-op for an empty path). */
export async function removeEventTmpRoot(root: string): Promise<void> {
  if (root) await rm(root, { recursive: true, force: true });
}

/**
 * Assert a plain append onto a clean store with `seedMarkers` already present
 * SUCCEEDS: it surfaces NO problems, lands the new record last, and the store
 * grows by one. The shared CLEAN-append regression across the event suites.
 */
export async function expectCleanAppendSucceeds(root: string, seedMarkers: string[]): Promise<void> {
  await seedEvents(root, seedMarkers);
  const rec = await appendEvent(root, eventInput("clean"));
  const { events, problems } = await readEvents(root);
  expect(problems).toEqual([]);
  expect(events).toHaveLength(seedMarkers.length + 1);
  expect(events.at(-1)?.id).toBe(rec.id);
}

/** The standard `relation-create` event input carrying a marker payload `n`. */
export function eventInput(n: string) {
  return { type: "relation-create" as const, origin: "sdk", payload: { n }, at: "2024-01-01T00:00:00Z" };
}

/**
 * Simulate the crash-between-append-and-seal window: append one COMPLETE, correctly
 * chained record line to `events.jsonl` WITHOUT updating the head anchor — exactly
 * the on-disk state a crash leaves after `appendLine` but before `sealHeadAnchor`.
 * The store is then ONE committed-looking record AHEAD of the (unchanged) head.
 *
 * @param root - Absolute project root with an existing event store.
 * @param marker - The payload marker `n` for the orphaned record.
 * @returns The orphaned record's minted `evt_<ULID>` id.
 */
export async function appendUnsealedRecord(root: string, marker: string): Promise<string> {
  const { events } = await readEvents(root);
  const last = events[events.length - 1];
  const prevHash = last ? eventPrevHash(last) : "genesis";
  const content = {
    id: `evt_orphan_${marker}` as const,
    type: "relation-create" as const,
    origin: "sdk",
    payload: { n: marker },
    at: "2024-01-01T00:00:00Z",
  };
  await appendFile(path.join(root, EVENTS_FILE), serializeEventRecord({ ...content, prevHash }));
  return content.id;
}

/** Append `markers` chained events to `root`, returning the store's header + record lines. */
export async function seedEvents(root: string, markers: string[]): Promise<string[]> {
  for (const m of markers) await appendEvent(root, eventInput(m));
  return (await readFile(path.join(root, EVENTS_FILE), "utf8")).split("\n").filter(Boolean);
}

/**
 * Tamper the store into a REORDERED chain by swapping the first two records (and
 * optionally appending a torn fragment), then assert `appendEvent` REJECTS with
 * {@link EventStoreChainError} AND leaves `events.jsonl` BYTE-IDENTICAL — the
 * verify-before-repair guarantee shared by the torn-repair and crash-recovery
 * suites. Seeds `["a","b","c"]` afresh on `root`.
 *
 * @param root - Absolute project root for a fresh store.
 * @param input - The event input the rejected append attempts.
 * @param withTornFragment - Also append {@link TORN_FRAGMENT} after the swap.
 */
export async function expectSwapTamperRejectedByteIdentical(
  root: string,
  input: AppendEventInput,
  withTornFragment = false,
): Promise<void> {
  const storePath = path.join(root, EVENTS_FILE);
  const [header, r1, r2, r3] = await seedEvents(root, ["a", "b", "c"]);
  await writeFile(storePath, [header, r2, r1, r3].join("\n") + "\n"); // swap r1<->r2
  if (withTornFragment) await appendFile(storePath, TORN_FRAGMENT);
  const before = await readFile(storePath, "utf8");
  await expect(appendEvent(root, input)).rejects.toBeInstanceOf(EventStoreChainError);
  expect(await readFile(storePath, "utf8")).toBe(before);
}

/**
 * Assert the store's empty-event readback surfaced a chain/anchor problem matching
 * `pattern` AND that {@link readEventsStrict} throws {@link EventStoreChainError}.
 * Shared by the F1 truncation/tamper tests.
 */
export async function expectEmptyEventsProblem(root: string, pattern: RegExp): Promise<void> {
  const { events, problems } = await readEvents(root);
  expect(events).toHaveLength(0);
  expect(problems.some((p) => pattern.test(p))).toBe(true);
  await expect(readEventsStrict(root)).rejects.toBeInstanceOf(EventStoreChainError);
}
