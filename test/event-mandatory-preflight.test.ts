/**
 * @file test/event-mandatory-preflight.test.ts
 * @description Audit FIX F2: the audit event store is a MANDATORY precondition for
 * a relation create and a lifecycle transition. With a symlinked / too-new /
 * tampered event store, `appendRelation` and `transitionLifecycle` FAIL CLOSED
 * BEFORE the mutation, leaving the relation/page UNCHANGED (no unaudited
 * mutation). With a healthy event store, both succeed AND emit their event.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { EVENTS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";
import { appendRelation } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { appendEvent } from "../src/events/store.js";
import { readEvents } from "../src/events/store-read.js";
import { RESEARCH_LITE_RELATIONS_PROFILE } from "./fixtures/profile-fixtures.js";
import {
  makeConfineRoots,
  cleanupConfineRoots,
  plantLeafSymlink,
  type ConfineRoots,
} from "./fixtures/graph-store-confine.js";

const EXP = "experiments/ablation-batch-size" as EntityId;
const IDEA = "ideas/sparse-routing" as EntityId;
const profile = (): ProfilePack => RESEARCH_LITE_RELATIONS_PROFILE as ProfilePack;

let ctx: ConfineRoots;
let root = "";
beforeEach(async () => { ctx = await makeConfineRoots("evt-preflight"); root = ctx.root; });
afterEach(async () => { await cleanupConfineRoots(ctx); });

const eventsPath = (): string => path.join(root, EVENTS_FILE);

/** Plant the events leaf as a symlink to a header-bearing out-of-tree file. */
const plantSymlinkedEvents = (): Promise<void> => plantLeafSymlink(ctx, "events");

/** Plant a too-new event store header so the strict read fails closed. */
async function plantTooNewEvents(): Promise<void> {
  await mkdir(path.join(root, WIKI_GRAPH_DIR), { recursive: true });
  await writeFile(eventsPath(), '{"kind":"event-store-header","schemaVersion":99}\n', "utf8");
}

/** Seed one healthy event, then drop its record so the head anchor mismatches (tamper). */
async function plantTamperedEvents(): Promise<void> {
  await appendEvent(root, { type: "relation-create", origin: "sdk", payload: {}, at: "2024-01-01T00:00:00Z" });
  const header = (await readFile(eventsPath(), "utf8")).split("\n").filter(Boolean)[0];
  await writeFile(eventsPath(), header + "\n"); // header-only; events.head still points at the dropped record
}

describe("FIX F2 — relation create fails closed on an unhealthy event store", () => {
  it.each([
    ["symlinked", plantSymlinkedEvents],
    ["too-new", plantTooNewEvents],
    ["tampered", plantTamperedEvents],
  ])("leaves the relation UNCHANGED when the event store is %s", async (_label, plant) => {
    await plant();
    await expect(appendRelation(root, profile(), { type: "tests", from: EXP, to: IDEA })).rejects.toThrow();
    const { relations } = await readRelations(root);
    expect(relations).toEqual([]);
  });
});

describe("FIX F2 — lifecycle transition fails closed on an unhealthy event store", () => {
  it.each([
    ["symlinked", plantSymlinkedEvents],
    ["too-new", plantTooNewEvents],
    ["tampered", plantTamperedEvents],
  ])("leaves the page UNCHANGED when the event store is %s", async (_label, plant) => {
    await plant();
    const pagePath = path.join(root, "wiki/ideas", "sparse-routing.md");
    const before = await readFile(pagePath, "utf8");
    await expect(
      transitionLifecycle(root, "ideas", "sparse-routing", "testing"),
    ).rejects.toThrow();
    expect(await readFile(pagePath, "utf8")).toBe(before);
  });
});

describe("FIX F2 — healthy event store still permits both mutations + emits", () => {
  it("a relation create succeeds and emits a relation-create event", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP, to: IDEA });
    const { relations } = await readRelations(root);
    expect(relations.map((r) => r.id)).toEqual([ref.id]);
    const { events } = await readEvents(root);
    expect(events.map((e) => e.type)).toEqual(["relation-create"]);
  });

  it("a lifecycle transition succeeds and emits a lifecycle-transition event", async () => {
    await transitionLifecycle(root, "ideas", "sparse-routing", "testing");
    const page = await readFile(path.join(root, "wiki/ideas", "sparse-routing.md"), "utf8");
    expect(page).toMatch(/status:\s*testing/);
    const { events } = await readEvents(root);
    expect(events.map((e) => e.type)).toEqual(["lifecycle-transition"]);
  });
});
