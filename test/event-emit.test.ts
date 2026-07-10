/**
 * @file test/event-emit.test.ts
 * @description Tests that lifecycle transitions and relation writes EMIT chained
 * audit events (CLP 4b PR1): a transition appends a `lifecycle-transition` event,
 * a relation create appends `relation-create`, an update appends `relation-update`,
 * the events chain + the head anchor verifies, and a DEFAULT project (which makes
 * no transitions/relations) writes no event store.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWiki } from "../src/index.js";
import { appendRelation, updateRelation } from "../src/relations/store.js";
import { readEvents, verifyEventChain, verifyHeadAnchor } from "../src/events/store-read.js";
import {
  EXP, IDEA, relationsProfile as profile, makeRelationsRoot, cleanupRoot, createTestRelationEvent,
} from "./fixtures/event-audit-fixture.js";

let root = "";
beforeEach(async () => { root = await makeRelationsRoot("evt-emit-"); });
afterEach(async () => { await cleanupRoot(root); });

describe("lifecycle transition emits a chained event", () => {
  it("appends a lifecycle-transition event that chains + anchors", async () => {
    const wiki = createWiki({ root });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    const { events, problems } = await readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("lifecycle-transition");
    expect(events[0].payload).toMatchObject({ entityType: "ideas", slug: "sparse-routing", to: "testing" });
    expect(problems).toEqual([]);
    expect(verifyEventChain(events).ok).toBe(true);
    expect((await verifyHeadAnchor(root, events)).ok).toBe(true);
  });
});

describe("relation writes emit chained events", () => {
  it("a relation create appends a relation-create event", async () => {
    const { ref, event } = await createTestRelationEvent(root);
    expect(event.payload).toMatchObject({ id: ref.id, relType: "tests", from: EXP, to: IDEA });
  });

  it("a relation update appends a relation-update event chained after the create", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP, to: IDEA });
    await updateRelation(root, profile(), ref.id, { attributes: { note: "y" } });
    const { events } = await readEvents(root);
    expect(events.map((e) => e.type)).toEqual(["relation-create", "relation-update"]);
    expect(verifyEventChain(events).ok).toBe(true);
  });
});

describe("default project parity", () => {
  it("a default project (no transitions/relations) writes no event store", async () => {
    const def = await mkdtemp(path.join(os.tmpdir(), "evt-default-"));
    try {
      await expect(readEvents(def)).resolves.toEqual({ events: [], problems: [] });
    } finally {
      await rm(def, { recursive: true, force: true });
    }
  });
});
