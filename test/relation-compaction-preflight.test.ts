/**
 * @file test/relation-compaction-preflight.test.ts
 * @description Holistic review FIX 1 + FIX 2 for relation compaction:
 *  - FIX 1: `compactRelations` PRE-FLIGHTS the audit event store BEFORE rewriting
 *    the relation store (mirroring `appendRelationLocked`). A TAMPERED events.jsonl
 *    (two records swapped → broken chain) BLOCKS the compaction (EventStoreChainError)
 *    and leaves `wiki/graph/relations.jsonl` BYTE-IDENTICAL.
 *  - FIX 2: the `relation-compact` payload bounds its dropped-id list to a SAMPLE
 *    (<= the cap) so a large compaction can never exceed the event record cap; the
 *    full count is still recorded.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { EVENTS_FILE, RELATIONS_FILE, MAX_EVENT_RECORD_BYTES } from "../src/utils/constants.js";
import { appendRelation, updateRelation, compactRelations } from "../src/relations/store.js";
import { readEvents } from "../src/events/store-read.js";
import { EventStoreChainError } from "../src/events/types.js";
import { EXPERIMENT_A as EXP_A, IDEA_B, experimentsIdeasProfile } from "./fixtures/profile-fixtures.js";

/** A profile with one directed `tests` relation type (experiments → ideas). */
function profile(): ProfilePack {
  return experimentsIdeasProfile({ tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } });
}

let root = "";
const eventsPath = (): string => path.join(root, EVENTS_FILE);
const relationsPath = (): string => path.join(root, RELATIONS_FILE);

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-compact-pf-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Append N distinct `tests` relations (each emits one chained event). */
async function seedRelations(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: `ideas/n${i}` as EntityId, attributes: {} });
  }
}

/**
 * Seed ONE relation then update its attributes twice, leaving THREE on-disk
 * records for the same id (two superseded). A healthy compaction would collapse
 * to the latest-per-id and SHRINK the file — so a tampered-store run that leaves
 * the file byte-identical proves the rewrite never happened (the pre-flight
 * blocked it BEFORE `writeCompactedAtomically`).
 */
async function seedSupersededVersions(): Promise<void> {
  const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { v: "1" } });
  await updateRelation(root, profile(), ref.id, { attributes: { v: "2" } });
  await updateRelation(root, profile(), ref.id, { attributes: { v: "3" } });
}

/** Swap the two trailing event records so the hash chain no longer verifies. */
async function tamperSwapTwoEvents(): Promise<void> {
  const lines = (await readFile(eventsPath(), "utf8")).split("\n").filter(Boolean);
  const [a, b] = [lines[lines.length - 2], lines[lines.length - 1]];
  lines[lines.length - 2] = b;
  lines[lines.length - 1] = a;
  await writeFile(eventsPath(), `${lines.join("\n")}\n`, "utf8");
}

describe("FIX 1 — compaction pre-flights the audit store before mutating", () => {
  it("a tampered events.jsonl blocks a SHRINKING compaction and leaves relations.jsonl byte-identical", async () => {
    // Superseded versions mean a healthy compaction WOULD drop records and shrink
    // the file — so an unchanged file proves the rewrite never ran (pre-flight first).
    await seedSupersededVersions();
    const before = await readFile(relationsPath());
    await tamperSwapTwoEvents();
    await expect(compactRelations(root, profile())).rejects.toBeInstanceOf(EventStoreChainError);
    expect(await readFile(relationsPath())).toEqual(before);
  });

  it("a healthy audit store still compacts and emits the relation-compact event", async () => {
    await seedRelations(1);
    await compactRelations(root, profile());
    const { events } = await readEvents(root);
    expect(events.map((e) => e.type)).toContain("relation-compact");
  });
});

describe("FIX 2 — compaction event payload bounds the dropped-id sample", () => {
  it("records the full droppedCount but caps droppedIdsSample under the record cap", async () => {
    await seedRelations(60); // all dropped when compacted under a relations-less profile
    const empty: ProfilePack = { ...profile(), relations: {} };
    await compactRelations(root, empty);
    const compact = (await readEvents(root)).events.find((e) => e.type === "relation-compact");
    const payload = compact?.payload as { droppedCount: number; droppedIdsSample: string[] };
    expect(payload.droppedCount).toBe(60);
    expect(payload.droppedIdsSample).toHaveLength(50);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(MAX_EVENT_RECORD_BYTES);
  });
});
