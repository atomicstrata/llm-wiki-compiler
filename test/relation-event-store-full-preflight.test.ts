/**
 * @file test/relation-event-store-full-preflight.test.ts
 * @description TDD teeth for the relation-side STORE-FULL audit pre-flight (mirrors
 * the lifecycle fix). A near-full event store (`MAX_EVENT_STORE_BYTES`, mocked tiny
 * here) must make a relation create / compaction FAIL CLOSED with NOTHING committed
 * — not commit the relation record and THEN throw `EventStoreFullError` on the
 * trailing audit append, leaving an UNAUDITED relation on disk.
 *
 * Probes:
 *   - createRelation store-full teeth: a NEW (non-duplicate) relation against an
 *     event store sitting just under the cap throws `EventStoreFullError` and the
 *     `relations.jsonl` record count is UNCHANGED (pre-fix: the record landed, then
 *     the event threw → record count +1 with no event = unaudited).
 *   - compactRelations store-full teeth: superseded records + a near-full event
 *     store → `compactRelations` fails closed with the store BYTE-IDENTICAL
 *     (pre-fix: it rewrote-then-failed).
 *   - Happy path: a normal create/compaction on a non-full store still appends +
 *     emits the event; the dedup path appends/emits nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { EVENTS_FILE, RELATIONS_FILE } from "../src/utils/constants.js";
import { appendRelation, updateRelation, compactRelations } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";
import { readEvents } from "../src/events/store-read.js";
import { EventStoreFullError } from "../src/events/types.js";
import { EXPERIMENT_A as EXP_A, IDEA_B, experimentsIdeasProfile } from "./fixtures/profile-fixtures.js";

// A tiny whole-file event cap so a handful of relation events drive the store to
// the brink without writing 64 MB. Inlined literal: vi.mock is hoisted above consts.
vi.mock("../src/utils/constants.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/constants.js")>();
  return { ...actual, MAX_EVENT_STORE_BYTES: 900 };
});

/** A profile with one directed `tests` relation type (experiments → ideas). */
function profile(): ProfilePack {
  return experimentsIdeasProfile({ tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } });
}

let root = "";
const relationsPath = (): string => path.join(root, RELATIONS_FILE);

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-evt-full-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const relationCount = async (): Promise<number> => (await readRelations(root)).relations.length;

/**
 * Append distinct `tests` relations until the NEXT relation's audit event would
 * cross the (mocked tiny) event-store cap — i.e. the create throws
 * `EventStoreFullError`. Returns the last attempted (now-rejected) target so the
 * caller can re-probe it. The store is left sitting just under the cap.
 */
async function fillEventStoreToBrink(): Promise<EntityId> {
  for (let i = 0; i < 50; i++) {
    const to = `ideas/n${i}` as EntityId;
    try {
      await appendRelation(root, profile(), { type: "tests", from: EXP_A, to, attributes: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(EventStoreFullError);
      return to;
    }
  }
  throw new Error("event store never reached the cap");
}

describe("createRelation — store-full audit pre-flight teeth", () => {
  it("fails closed (EventStoreFullError) with the relation NOT appended", async () => {
    await fillEventStoreToBrink();
    const before = await relationCount();
    const to = `ideas/fresh` as EntityId;
    await expect(
      appendRelation(root, profile(), { type: "tests", from: EXP_A, to, attributes: {} }),
    ).rejects.toBeInstanceOf(EventStoreFullError);
    expect(await relationCount()).toBe(before); // unaudited relation never landed
  });
});

describe("compactRelations — store-full audit pre-flight teeth", () => {
  it("fails closed with relations.jsonl byte-identical when the compact event won't fit", async () => {
    // Superseded versions: a healthy compaction WOULD shrink the file, so an
    // unchanged file proves the rewrite never ran (pre-flight blocked it first).
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { v: "1" } });
    await updateRelation(root, profile(), ref.id, { attributes: { v: "2" } });
    await fillEventStoreToBrink();
    const before = await readFile(relationsPath());
    await expect(compactRelations(root, profile())).rejects.toBeInstanceOf(EventStoreFullError);
    expect(await readFile(relationsPath())).toEqual(before);
  });
});

describe("happy path — non-full store still appends + emits", () => {
  it("a normal create appends the relation and emits the relation-create event", async () => {
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });
    expect(await relationCount()).toBe(1);
    expect((await readEvents(root)).events.map((e) => e.type)).toContain("relation-create");
  });

  it("the dedup path appends nothing and emits nothing", async () => {
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });
    const eventsBefore = (await readEvents(root)).events.length;
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });
    expect(await relationCount()).toBe(1);
    expect((await readEvents(root)).events.length).toBe(eventsBefore);
  });
});
