/**
 * @file test/event-audit-content.test.ts
 * @description Tests for the Phase 4b audit-CONTENT evolution: the trust decision
 * is recorded on relation events (B7), relation compaction emits a chained
 * `relation-compact` audit event (A5), lifecycle-transition events carry NO
 * `decision` (FSM-validated, no trust verdict — intentional), and the chain still
 * verifies across a mix of relation-create + relation-compact + lifecycle events.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import type { ProfilePack } from "../src/profile/types.js";
import { createWiki } from "../src/index.js";
import { appendRelation, compactRelations } from "../src/relations/store.js";
import { readEvents } from "../src/events/store-read.js";
import {
  EXP, IDEA, relationsProfile, makeRelationsRoot, cleanupRoot, readChainVerified, createTestRelationEvent,
} from "./fixtures/event-audit-fixture.js";

let root = "";
beforeEach(async () => { root = await makeRelationsRoot("evt-audit-"); });
afterEach(async () => { await cleanupRoot(root); });

describe("B7 — relation events record the composed trust decision", () => {
  it("a createRelation through the trust path records decision=allow", async () => {
    const { event } = await createTestRelationEvent(root);
    expect(event.decision).toBe("allow");
  });
});

/** A profile whose `tests` relation type is undeclared, so a `tests` record is now invalid and dropped. */
const noRelationsProfile = (): ProfilePack => ({ ...relationsProfile(), relations: {} });

describe("A5 — compaction emits a chained relation-compact event", () => {
  it("records before/after counts + dropped ids, and the chain still verifies", async () => {
    const dropped = await appendRelation(root, relationsProfile(), { type: "tests", from: EXP, to: IDEA });
    await compactRelations(root, noRelationsProfile()); // the `tests` record is now invalid → dropped
    const compact = (await readChainVerified(root)).find((e) => e.type === "relation-compact");
    expect(compact?.payload).toMatchObject({ countBefore: 1, countAfter: 0, droppedCount: 1 });
    expect(compact?.payload.droppedIdsSample).toEqual([dropped.id]);
  });
});

describe("lifecycle transitions carry NO decision (FSM-validated, intentional)", () => {
  it("emits a well-formed lifecycle-transition event with decision absent", async () => {
    const wiki = createWiki({ root });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    const { events } = await readEvents(root);
    expect(events[0].type).toBe("lifecycle-transition");
    expect(events[0].decision).toBeUndefined();
    expect(events[0].payload).toMatchObject({ entityType: "ideas", slug: "sparse-routing", to: "testing" });
  });
});

describe("regression — chain verifies across create + compact + lifecycle", () => {
  it("a mixed event stream chains and anchors intact", async () => {
    const wiki = createWiki({ root });
    await wiki.createRelation({ type: "tests", from: EXP, to: IDEA });
    await compactRelations(root, relationsProfile());
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    const events = await readChainVerified(root);
    expect(events.map((e) => e.type)).toEqual(["relation-create", "relation-compact", "lifecycle-transition"]);
  });
});
