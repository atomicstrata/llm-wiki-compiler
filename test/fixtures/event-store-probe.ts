/**
 * @file test/fixtures/event-store-probe.ts
 * @description Shared event-store test scaffolding for the FIX F1 fail-closed
 * tests: the standard event-input factory and a helper that appends N chained
 * events and returns the on-disk header + record lines (so a test can drop /
 * reorder / truncate them). Centralized so the probe boilerplate is not redrawn
 * per fail-closed test file.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { EVENTS_FILE } from "../../src/utils/constants.js";
import { appendEvent } from "../../src/events/store.js";
import { readEvents, readEventsStrict } from "../../src/events/store-read.js";
import { EventStoreChainError } from "../../src/events/types.js";

/** The standard `relation-create` event input carrying a marker payload `n`. */
export function eventInput(n: string) {
  return { type: "relation-create" as const, origin: "sdk", payload: { n }, at: "2024-01-01T00:00:00Z" };
}

/** Append `markers` chained events to `root`, returning the store's header + record lines. */
export async function seedEvents(root: string, markers: string[]): Promise<string[]> {
  for (const m of markers) await appendEvent(root, eventInput(m));
  return (await readFile(path.join(root, EVENTS_FILE), "utf8")).split("\n").filter(Boolean);
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
