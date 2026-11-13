/**
 * @file test/storage/event-strict-binding.test.ts
 * @description The strict audit-log read as ONE body over the event read sources,
 * `readEventsStrictFrom`, with no project directory: the whole read (store, then
 * the head anchor), then the strict verification (the chain, then a SECOND, fresh
 * anchor read), failing closed with the same errors as the root form.
 *
 * HOW IT IS BUILT. The three audit seeds every bound-write suite mints (a fresh
 * project, a real v1 store with one sealed record, and a tampered head) are
 * written on real disk and read with the root form `readEventsStrict(root)`; the
 * same seeds are then read through the body over the shared memory event sources.
 * Outcomes must agree, by value or by error name.
 *
 * NOT SHOWN HERE: the store's corrupt, too-new and symlink refusals and the
 * torn-tail rules; the event-store suites show those.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { readEventsStrict, readEventsStrictFrom } from "../../src/events/store-read.js";
import { tempRootTracker } from "../temp-roots.js";
import { auditSeeds, ONE } from "./audit-event-fixtures.js";
import { writeFiles } from "./copied-project.js";
import { memoryEvents } from "./journal-memory-map.js";

const PREFIX = "event-strict-binding-";
const SEEDS = auditSeeds({ ".llmwiki/profile.json": "{}" });
type Seed = keyof typeof SEEDS;
const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());

/** A strict read's outcome: the event ids, or the error's name. */
const outcomeOf = (read: Promise<{ id: string }[]>): Promise<unknown> =>
  read.then((events) => events.map((event) => event.id), (error: Error) => error.name);

/** The seed's files as the memory event sources hold them, with every read logged. */
function memoryOf(seed: Seed, log: string[]) {
  const files = new Map(Object.entries(SEEDS[seed]));
  return memoryEvents({ files, dirs: new Set([".llmwiki", "wiki", "wiki/graph"]), log });
}

describe("the strict audit-log read over its sources", () => {
  it("S1 agrees with the root form on a fresh, a sealed and a tampered store", async () => {
    const outcomes: Record<string, [unknown, unknown]> = {};
    for (const seed of Object.keys(SEEDS) as Seed[]) {
      const root = await tracker.create(PREFIX);
      await writeFiles(root, SEEDS[seed]);
      outcomes[seed] = [await outcomeOf(readEventsStrict(root)), await outcomeOf(readEventsStrictFrom(memoryOf(seed, [])))];
    }
    expect(outcomes).toEqual({
      fresh: [[], []], v1: [[ONE.id], [ONE.id]], tampered: ["EventStoreChainError", "EventStoreChainError"],
    });
  });

  it("S2 reads the store, then the anchor, then the anchor AGAIN for the strict verification", async () => {
    const log: string[] = [];
    await readEventsStrictFrom(memoryOf("v1", log));
    expect(log).toEqual(["read events.jsonl", "private-dir", "head events.head", "private-dir", "head events.head"]);
  });

  it("S3 a tampered head fails closed after both anchor reads; a fresh project asks its absent head twice and passes", async () => {
    const tampered: string[] = [];
    await expect(readEventsStrictFrom(memoryOf("tampered", tampered))).rejects.toThrow("does not match last event");
    expect(tampered.filter((call) => call.startsWith("head"))).toHaveLength(2);
    const fresh: string[] = [];
    await readEventsStrictFrom(memoryOf("fresh", fresh));
    expect(fresh.filter((call) => call.startsWith("head"))).toHaveLength(2);
  });
});
