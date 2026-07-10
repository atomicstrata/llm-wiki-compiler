/**
 * @file test/relation-precondition.test.ts
 * @description Adversarial unit battery for the PURE relation-count precondition
 * checker {@link checkRelationPreconditions}. Because the checker reads no store
 * and takes no lock, its strict count semantics — object-scope, type+role,
 * otherTypes, endpoint qualification (facts-or-null), the fail-closed
 * `otherStates` lifecycle filter, and distinct-target dedup — are proven here in
 * isolation with synthetic relations and stub facts resolvers.
 */

import { describe, it, expect } from "vitest";
import {
  buildRelationEndpointIndex,
  checkRelationPreconditions,
  EndpointUnreadableError,
  type EndpointFacts,
  type EndpointResolver,
} from "../src/relations/precondition.js";
import { entityId } from "../src/profile/identity.js";
import type { EntityId, LifecycleDef, RelationCountReq } from "../src/profile/types.js";
import type { RelationId, RelationRef } from "../src/relations/types.js";

/** This entity's branded id — the object whose preconditions are under test. */
const SELF: EntityId = entityId("paper", "self");
/** The state being entered, keyed in the synthetic lifecycle. */
const STATE = "published";

/** Build an EntityId for a source page slug. */
function source(slug: string): EntityId {
  return entityId("source", slug);
}

let relSeq = 0;
/** Build a synthetic relation with a unique id and a dummy content hash. */
function rel(type: string, from: EntityId, to: EntityId): RelationRef {
  relSeq += 1;
  const id = `rel_${String(relSeq).padStart(26, "0")}` as RelationId;
  return { id, type, from, to, attributes: {}, contentHash: `hash-${relSeq}` };
}

/** A lifecycle whose {@link STATE} carries the given relation-count requirements. */
function lifecycleWith(...reqs: RelationCountReq[]): LifecycleDef {
  return {
    field: "status",
    initial: "draft",
    terminal: ["published"],
    transitions: { draft: ["published"] },
    transitionRelationRequirements: { [STATE]: reqs },
  };
}

/** A stub facts resolver: an id qualifies (state-less facts) iff it is in `existing`. */
function resolver(...existing: EntityId[]): EndpointResolver {
  const set = new Set<string>(existing);
  return async (id: EntityId) => (set.has(id) ? {} : null);
}

/** A stub facts resolver with per-id facts (an absent id does not qualify at all). */
function factsResolver(facts: Record<string, EndpointFacts>): EndpointResolver {
  return async (id: EntityId) => facts[id] ?? null;
}

/** Run the checker for {@link SELF} entering {@link STATE}. */
function check(lifecycle: LifecycleDef, liveValidRelations: RelationRef[], resolveEndpoint: EndpointResolver) {
  return checkRelationPreconditions({ entityType: "paper", slug: "self", enteredState: STATE, lifecycle, liveValidRelations, resolveEndpoint });
}

const cites = (minCount: number, otherTypes?: string[]): RelationCountReq => ({ relationType: "cites", role: "from", minCount, ...(otherTypes ? { otherTypes } : {}) });

/** A `cites[from]` requirement with an `otherStates` lifecycle-state filter. */
const citesInStates = (minCount: number, otherStates: string[]): RelationCountReq => ({ relationType: "cites", role: "from", minCount, otherStates });

describe("checkRelationPreconditions", () => {
  it("satisfied: a single distinct existing endpoint meets minCount 1", async () => {
    const s1 = source("s1");
    const unmet = await check(lifecycleWith(cites(1)), [rel("cites", SELF, s1)], resolver(s1));
    expect(unmet).toEqual([]);
  });

  it("N=2 real count: two distinct existing endpoints meet minCount 2", async () => {
    const s1 = source("s1");
    const s2 = source("s2");
    const rels = [rel("cites", SELF, s1), rel("cites", SELF, s2)];
    const unmet = await check(lifecycleWith(cites(2)), rels, resolver(s1, s2));
    expect(unmet).toEqual([]);
  });

  it("N-1 boundary: exactly minCount-1 distinct existing endpoints is unmet", async () => {
    const s1 = source("s1");
    const unmet = await check(lifecycleWith(cites(2)), [rel("cites", SELF, s1)], resolver(s1));
    expect(unmet).toEqual([{ relationType: "cites", role: "from", needed: 2, actual: 1 }]);
  });

  it("N boundary: exactly minCount distinct existing endpoints is satisfied", async () => {
    const [s1, s2, s3] = [source("s1"), source("s2"), source("s3")];
    const rels = [rel("cites", SELF, s1), rel("cites", SELF, s2), rel("cites", SELF, s3)];
    const unmet = await check(lifecycleWith(cites(3)), rels, resolver(s1, s2, s3));
    expect(unmet).toEqual([]);
  });

  it("endpoint-role: a relation with this entity on the WRONG side does not count", async () => {
    const other = entityId("paper", "other");
    // req role is "from", but here SELF is the "to" endpoint -> must not count.
    const unmet = await check(lifecycleWith(cites(1)), [rel("cites", other, SELF)], resolver(SELF, other));
    expect(unmet).toEqual([{ relationType: "cites", role: "from", needed: 1, actual: 0 }]);
  });

  it("existence: a qualifying relation to a nonexistent endpoint does not count, reported as not-evidence", async () => {
    const ghost = source("ghost");
    const unmet = await check(lifecycleWith(cites(1)), [rel("cites", SELF, ghost)], resolver());
    expect(unmet).toEqual([
      { relationType: "cites", role: "from", needed: 1, actual: 0, rejected: [{ id: ghost, reason: "not-evidence" }] },
    ]);
  });

  it("unreadable endpoint: a resolver I/O fault propagates as EndpointUnreadableError, NOT a silent miss", async () => {
    const s1 = source("s1");
    const faulting: EndpointResolver = async () => {
      throw new EndpointUnreadableError(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    };
    await expect(check(lifecycleWith(cites(1)), [rel("cites", SELF, s1)], faulting)).rejects.toBeInstanceOf(
      EndpointUnreadableError,
    );
  });

  it("otherStates: an endpoint whose state is in the filter counts", async () => {
    const s1 = source("s1");
    const unmet = await check(lifecycleWith(citesInStates(1, ["open", "sealed"])), [rel("cites", SELF, s1)], factsResolver({ [s1]: { state: "sealed" } }));
    expect(unmet).toEqual([]);
  });

  it("otherStates: an endpoint whose state is NOT in the filter does not count, reported with its state", async () => {
    const s1 = source("s1");
    const unmet = await check(lifecycleWith(citesInStates(1, ["open"])), [rel("cites", SELF, s1)], factsResolver({ [s1]: { state: "retired" } }));
    expect(unmet).toEqual([
      { relationType: "cites", role: "from", otherStates: ["open"], needed: 1, actual: 0, rejected: [{ id: s1, reason: "wrong-state", state: "retired" }] },
    ]);
  });

  it("otherStates fail-closed: an endpoint carrying NO lifecycle state does not count under a filter", async () => {
    const s1 = source("s1");
    const unmet = await check(lifecycleWith(citesInStates(1, ["open"])), [rel("cites", SELF, s1)], factsResolver({ [s1]: {} }));
    expect(unmet).toEqual([
      { relationType: "cites", role: "from", otherStates: ["open"], needed: 1, actual: 0, rejected: [{ id: s1, reason: "wrong-state" }] },
    ]);
  });

  it("otherStates omitted: a state-less endpoint still counts (any state or no lifecycle)", async () => {
    const s1 = source("s1");
    const unmet = await check(lifecycleWith(cites(1)), [rel("cites", SELF, s1)], factsResolver({ [s1]: {} }));
    expect(unmet).toEqual([]);
  });

  it("distinct-target: two relations to the SAME endpoint count as one", async () => {
    const s1 = source("s1");
    const dupes = [rel("cites", SELF, s1), rel("cites", SELF, s1)];
    const unmet = await check(lifecycleWith(cites(2)), dupes, resolver(s1));
    expect(unmet).toEqual([{ relationType: "cites", role: "from", needed: 2, actual: 1 }]);
  });

  it("object-scope: a DIFFERENT entity's relations do not satisfy this precondition", async () => {
    const someoneElse = entityId("paper", "elsewhere");
    const s1 = source("s1");
    const unmet = await check(lifecycleWith(cites(1)), [rel("cites", someoneElse, s1)], resolver(s1));
    expect(unmet).toEqual([{ relationType: "cites", role: "from", needed: 1, actual: 0 }]);
  });

  it("otherTypes: an endpoint whose type is NOT in otherTypes does not count", async () => {
    const wrong = entityId("paper", "p1"); // type "paper" not in ["source"]
    const unmet = await check(lifecycleWith(cites(1, ["source"])), [rel("cites", SELF, wrong)], resolver(wrong));
    expect(unmet).toEqual([{ relationType: "cites", role: "from", otherTypes: ["source"], needed: 1, actual: 0 }]);
  });

  it("otherTypes omitted: any other endpoint type counts", async () => {
    const anyType = entityId("book", "b1");
    const unmet = await check(lifecycleWith(cites(1)), [rel("cites", SELF, anyType)], resolver(anyType));
    expect(unmet).toEqual([]);
  });

  it("relationIndex parity: the precomputed index yields the SAME result as a linear scan", async () => {
    const [s1, s2] = [source("s1"), source("s2")];
    const other = entityId("paper", "other");
    const rels = [rel("cites", SELF, s1), rel("cites", SELF, s2), rel("cites", other, s1), rel("cites", other, SELF)];
    const args = { entityType: "paper", slug: "self", enteredState: STATE, lifecycle: lifecycleWith(cites(2)), liveValidRelations: rels, resolveEndpoint: resolver(s1, s2) };
    const scanned = await checkRelationPreconditions(args);
    const indexed = await checkRelationPreconditions({ ...args, relationIndex: buildRelationEndpointIndex(rels) });
    expect(indexed).toEqual(scanned);
    expect(indexed).toEqual([]); // object-scope holds: only SELF-from edges to s1,s2 count
  });

  it("relationIndex parity: object-scope shortfall reported identically via the index", async () => {
    const s1 = source("s1");
    const rels = [rel("cites", SELF, s1)];
    const args = { entityType: "paper", slug: "self", enteredState: STATE, lifecycle: lifecycleWith(cites(2)), liveValidRelations: rels, resolveEndpoint: resolver(s1) };
    const indexed = await checkRelationPreconditions({ ...args, relationIndex: buildRelationEndpointIndex(rels) });
    expect(indexed).toEqual([{ relationType: "cites", role: "from", needed: 2, actual: 1 }]);
  });

  it("no requirement: a state without preconditions returns [] without resolving endpoints", async () => {
    let calls = 0;
    const spy = async () => {
      calls += 1;
      return true;
    };
    const bare: LifecycleDef = { field: "status", initial: "draft", terminal: ["archived"], transitions: {} };
    const unmet = await check(bare, [rel("cites", SELF, source("s1"))], spy);
    expect(unmet).toEqual([]);
    expect(calls).toBe(0);
  });
});
